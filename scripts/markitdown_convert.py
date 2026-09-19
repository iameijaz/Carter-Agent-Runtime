"""
Thin wrapper around markitdown. Accepts a file path or URL as argv[1],
converts to Markdown, and prints to stdout. Carter calls this as a subprocess.
"""
import sys
import os

def main():
    if len(sys.argv) < 2:
        print("Usage: markitdown_convert.py <path-or-url>", file=sys.stderr)
        sys.exit(1)

    source = sys.argv[1]

    try:
        from markitdown import MarkItDown
        md = MarkItDown()
        result = md.convert(source)
        print(result.text_content)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
