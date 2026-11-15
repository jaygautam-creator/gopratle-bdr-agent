#!/usr/bin/env python3
"""Store a Google service-account JSON key in .env as GOOGLE_SERVICE_ACCOUNT_B64 (never printed).

    python3 scripts/sa_to_env.py ~/Downloads/your-key.json
"""
import base64, json, re, sys
from pathlib import Path

if len(sys.argv) != 2:
    sys.exit(__doc__)
key = json.loads(Path(sys.argv[1]).expanduser().read_text())
for field in ("client_email", "private_key"):
    if field not in key:
        sys.exit(f"not a service-account key: missing {field}")
b64 = base64.b64encode(json.dumps(key).encode()).decode()
env = Path(__file__).resolve().parent.parent / ".env"
text = env.read_text() if env.exists() else ""
line = f"GOOGLE_SERVICE_ACCOUNT_B64={b64}"
text = re.sub(r"^GOOGLE_SERVICE_ACCOUNT_B64=.*$", lambda m: line, text, flags=re.M) if re.search(r"^GOOGLE_SERVICE_ACCOUNT_B64=", text, re.M) else text.rstrip("\n") + "\n" + line + "\n"
env.write_text(text)
print(f"saved to .env. Share your Google Sheet (Editor) with: {key['client_email']}")
