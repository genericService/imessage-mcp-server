#!/usr/bin/env python3
"""Mock whisper-cli for unit testing iMessage transcription without real whisper."""
import sys
import os
import time
import json
import argparse

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-m", "--model", default=None)
    parser.add_argument("-f", "--file", default=None)
    parser.add_argument("-l", "--language", default="auto")
    parser.add_argument("-oj", "--output-json", action="store_true")
    parser.add_argument("-ojf", "--output-json-full", action="store_true")
    parser.add_argument("-of", "--output-file", default=None)
    parser.add_argument("-np", "--no-prints", action="store_true")
    parser.add_argument("-nt", "--no-timestamps", action="store_true")
    
    args, unknown = parser.parse_known_args()

    # Check for simulated failures
    if os.environ.get("MOCK_WHISPER_FAIL") == "1":
        sys.stderr.write("Simulated whisper-cli failure\n")
        sys.exit(1)

    # Check for simulated delays
    delay = float(os.environ.get("MOCK_WHISPER_DELAY", "0"))
    if delay > 0:
        time.sleep(delay)

    text = os.environ.get("MOCK_WHISPER_TEXT", "Hola, te veo mañana para la reunión.")
    lang = os.environ.get("MOCK_WHISPER_LANG", "es")
    
    output_prefix = args.output_file
    if output_prefix:
        out_json_path = output_prefix if output_prefix.endswith(".json") else f"{output_prefix}.json"
        data = {
            "result": {
                "language": lang
            },
            "transcription": [
                {
                    "timestamps": {
                        "from": "00:00:00,000",
                        "to": "00:00:02,500"
                    },
                    "offsets": {
                        "from": 0,
                        "to": 2500
                    },
                    "text": f" {text}"
                }
            ]
        }
        with open(out_json_path, "w", encoding="utf-8") as f:
            json.dump(data, f)
            
    sys.exit(0)

if __name__ == "__main__":
    main()
