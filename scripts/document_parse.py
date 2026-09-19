"""
Document parse script — 4-tier fallback chain:
  Tier 1: docling   (layout-aware, GPU-accelerated if available)
  Tier 2: marker    (layout-aware PDF → Markdown)
  Tier 3: pdfplumber (text + tables, fast)
  Tier 4: pymupdf   (last resort, always works)

Usage:
  python document_parse.py <file_path> [strategy]
  strategy: layout_aware (default) | text_fast | ocr_force

Outputs JSON to stdout:
  { "text": "...", "provider": "docling", "pages": N, "error": null }
"""
import sys
import json
import os
import traceback

def try_docling(file_path: str, strategy: str) -> dict:
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.datamodel.base_models import InputFormat

    pipeline_opts = PdfPipelineOptions()
    pipeline_opts.do_ocr = (strategy == "ocr_force")
    pipeline_opts.do_table_structure = True

    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_opts)}
    )
    result = converter.convert(file_path)
    text = result.document.export_to_markdown()
    pages = getattr(result.document, "num_pages", None) or len(result.document.pages)
    return {"text": text, "provider": "docling", "pages": pages}


def try_marker(file_path: str) -> dict:
    from marker.convert import convert_single_pdf
    from marker.models import load_all_models
    models = load_all_models()
    full_text, _, _ = convert_single_pdf(file_path, models)
    return {"text": full_text, "provider": "marker", "pages": None}


def try_pdfplumber(file_path: str) -> dict:
    import pdfplumber
    parts = []
    with pdfplumber.open(file_path) as pdf:
        pages = len(pdf.pages)
        for page in pdf.pages:
            text = page.extract_text() or ""
            parts.append(text)
            for table in page.extract_tables():
                rows = [" | ".join(str(c) for c in row) for row in table if row]
                parts.append("\n".join(rows))
    return {"text": "\n\n".join(parts), "provider": "pdfplumber", "pages": pages}


def try_pymupdf(file_path: str) -> dict:
    import fitz  # pymupdf
    doc = fitz.open(file_path)
    parts = [page.get_text("text") for page in doc]
    return {"text": "\n\n".join(parts), "provider": "pymupdf", "pages": len(doc)}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: document_parse.py <file_path> [strategy]"}))
        sys.exit(1)

    file_path = sys.argv[1]
    strategy  = sys.argv[2] if len(sys.argv) > 2 else "layout_aware"

    if not os.path.exists(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        sys.exit(1)

    ext = os.path.splitext(file_path)[1].lower()
    errors = {}

    # Non-PDF files go straight to pdfplumber/pymupdf or docling handles them
    if strategy == "text_fast" or ext not in (".pdf",):
        for fn, name in [(try_pdfplumber, "pdfplumber"), (try_pymupdf, "pymupdf")]:
            try:
                result = fn(file_path)
                if result["text"].strip():
                    print(json.dumps({**result, "error": None}))
                    return
            except Exception as e:
                errors[name] = str(e)
        # Fall through to docling for non-PDF office files

    # Tier 1: docling
    try:
        result = try_docling(file_path, strategy)
        if result["text"].strip():
            print(json.dumps({**result, "error": None}))
            return
        errors["docling"] = "empty output"
    except Exception as e:
        errors["docling"] = str(e)

    # Tier 2: marker
    try:
        result = try_marker(file_path)
        if result["text"].strip():
            print(json.dumps({**result, "error": None}))
            return
        errors["marker"] = "empty output"
    except Exception as e:
        errors["marker"] = str(e)

    # Tier 3: pdfplumber
    try:
        result = try_pdfplumber(file_path)
        if result["text"].strip():
            print(json.dumps({**result, "error": None}))
            return
        errors["pdfplumber"] = "empty output"
    except Exception as e:
        errors["pdfplumber"] = str(e)

    # Tier 4: pymupdf (last resort — always try)
    try:
        result = try_pymupdf(file_path)
        print(json.dumps({**result, "error": None, "fallback_errors": errors}))
        return
    except Exception as e:
        errors["pymupdf"] = str(e)

    print(json.dumps({"error": "All providers failed", "provider_errors": errors}))
    sys.exit(1)


if __name__ == "__main__":
    main()
