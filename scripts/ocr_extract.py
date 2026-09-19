"""
OCR extraction script — 3-tier fallback:
  Tier 1: PaddleOCR (ONNX local, GPU if available)
  Tier 2: Tesseract (local binary)
  Tier 3: Google Cloud Vision (remote, only if GOOGLE_CLOUD_VISION_KEY set)

Usage:
  python ocr_extract.py <image_path> [language_hint]

Outputs JSON to stdout:
  { "text": "...", "provider": "paddleocr", "confidence": 0.95, "error": null }
"""
import sys
import json
import os


def try_paddleocr(image_path: str, lang: str) -> dict:
    from paddleocr import PaddleOCR
    # use_gpu auto-detects CUDA
    ocr = PaddleOCR(use_angle_cls=True, lang=lang[:2], use_gpu=True, show_log=False)
    result = ocr.ocr(image_path, cls=True)
    lines = []
    confidences = []
    for block in (result or []):
        for line in (block or []):
            if line and len(line) >= 2:
                text, conf = line[1][0], line[1][1]
                lines.append(text)
                confidences.append(conf)
    avg_conf = sum(confidences) / len(confidences) if confidences else 0
    return {"text": "\n".join(lines), "provider": "paddleocr", "confidence": round(avg_conf, 3)}


def try_tesseract(image_path: str, lang: str) -> dict:
    import pytesseract
    from PIL import Image
    img = Image.open(image_path)
    # tesseract lang code mapping
    tess_lang = {"en": "eng", "de": "deu", "fr": "fra", "ar": "ara"}.get(lang[:2], "eng")
    text = pytesseract.image_to_string(img, lang=tess_lang)
    return {"text": text.strip(), "provider": "tesseract", "confidence": None}


def try_cloud_vision(image_path: str) -> dict:
    import base64
    import urllib.request
    import urllib.error

    api_key = os.environ.get("GOOGLE_CLOUD_VISION_KEY", "")
    if not api_key:
        raise RuntimeError("GOOGLE_CLOUD_VISION_KEY not set")

    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    payload = json.dumps({
        "requests": [{"image": {"content": b64},
                      "features": [{"type": "TEXT_DETECTION"}]}]
    }).encode()

    req = urllib.request.Request(
        f"https://vision.googleapis.com/v1/images:annotate?key={api_key}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read())

    text = data["responses"][0].get("fullTextAnnotation", {}).get("text", "")
    return {"text": text.strip(), "provider": "cloud_vision", "confidence": None}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: ocr_extract.py <image_path> [language_hint]"}))
        sys.exit(1)

    image_path = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "en"

    if not os.path.exists(image_path):
        print(json.dumps({"error": f"File not found: {image_path}"}))
        sys.exit(1)

    errors = {}

    for fn, name in [(lambda: try_paddleocr(image_path, lang), "paddleocr"),
                     (lambda: try_tesseract(image_path, lang), "tesseract")]:
        try:
            result = fn()
            if result["text"].strip():
                print(json.dumps({**result, "error": None}))
                return
            errors[name] = "empty output"
        except Exception as e:
            errors[name] = str(e)

    # Cloud vision last resort
    try:
        result = try_cloud_vision(image_path)
        if result["text"].strip():
            print(json.dumps({**result, "error": None, "fallback_errors": errors}))
            return
        errors["cloud_vision"] = "empty output"
    except Exception as e:
        errors["cloud_vision"] = str(e)

    print(json.dumps({"error": "All OCR providers failed", "provider_errors": errors}))
    sys.exit(1)


if __name__ == "__main__":
    main()
