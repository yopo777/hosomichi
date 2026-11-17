"""ほそみちナビの「🔐 暗号化して書き出す」で作ったファイル（.enc）を、ふつうの JSON にもどす

使い方:
    pip install cryptography
    python decrypt_mydata.py hosomichi-mydata-2026-11-17.enc
    → パスワードを聞かれるので入れると、おなじ場所に hosomichi-mydata-2026-11-17.json ができる

⚠ できた .json は暗号化されていないので、見おわったら消すか、人に見られない所に置いてね
"""
import getpass
import gzip
import pathlib
import sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MAGIC = b"HOSOMICHI-MYDATA-1\n"
ITER = 600000


def decrypt(data: bytes, pw: str) -> bytes:
    if not data.startswith(MAGIC):
        raise ValueError("ほそみちナビの暗号化ファイルじゃないみたい")
    m = len(MAGIC)
    salt, iv, ct = data[m:m + 16], data[m + 16:m + 28], data[m + 28:]
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(pw.encode("utf-8"))
    return gzip.decompress(AESGCM(key).decrypt(iv, ct, None))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    src = pathlib.Path(sys.argv[1])
    pw = getpass.getpass("🔑 パスワード: ")
    try:
        text = decrypt(src.read_bytes(), pw)
    except ValueError as e:
        sys.exit(str(e))
    except Exception:
        sys.exit("🔑 パスワードがちがうみたい（またはファイルがこわれてるかも）")
    dst = src.with_suffix(".json")
    dst.write_bytes(text)
    print(f"できたよ: {dst}（{len(text) / 1024:.0f}KB）")


if __name__ == "__main__":
    main()
