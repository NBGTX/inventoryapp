"""Token-cache encryption with Windows DPAPI (current-user scope), no extra dependency.

The MSAL token cache holds a refresh token. It used to sit on disk as plaintext JSON; it is now
encrypted with CryptProtectData, so only the same Windows user on the same machine can read it.

File format:  b"NBGDPAPI1\\n" + <DPAPI blob>
Legacy plaintext files are still read once; the next save rewrites them encrypted.
If the blob cannot be decrypted (different user/machine, corrupt) read_secure returns None and
the app simply asks the user to sign in again - it never crashes and never falls back to plaintext.
Non-Windows: plaintext passthrough (dev/test boxes only).
"""
from __future__ import annotations

import os

MAGIC = b"NBGDPAPI1\n"

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    class _BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]

    _crypt32 = ctypes.windll.crypt32
    _kernel32 = ctypes.windll.kernel32
    _crypt32.CryptProtectData.argtypes = [ctypes.POINTER(_BLOB), wintypes.LPCWSTR, ctypes.POINTER(_BLOB),
                                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_BLOB)]
    _crypt32.CryptProtectData.restype = wintypes.BOOL
    _crypt32.CryptUnprotectData.argtypes = [ctypes.POINTER(_BLOB), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(_BLOB),
                                            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_BLOB)]
    _crypt32.CryptUnprotectData.restype = wintypes.BOOL
    _kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    _kernel32.LocalFree.restype = ctypes.c_void_p

    def _call(fn, data: bytes, *mid) -> bytes:
        buf = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
        src = _BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
        out = _BLOB()
        if not fn(ctypes.byref(src), *mid, ctypes.byref(out)):
            raise OSError(ctypes.WinError())
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            _kernel32.LocalFree(out.pbData)

    def protect(data: bytes) -> bytes:
        return _call(lambda s, o: _crypt32.CryptProtectData(s, "NBG Hub token cache", None, None, None, 0, o), data)

    def unprotect(data: bytes) -> bytes:
        return _call(lambda s, o: _crypt32.CryptUnprotectData(s, None, None, None, None, 0, o), data)
else:  # pragma: no cover - dev boxes only
    def protect(data: bytes) -> bytes:
        return data

    def unprotect(data: bytes) -> bytes:
        return data


def write_secure(path: str, text: str) -> None:
    """Atomically write `text` encrypted. Raises on failure (callers must not fall back to plaintext)."""
    blob = MAGIC + protect(text.encode("utf-8")) if os.name == "nt" else text.encode("utf-8")
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as f:
        f.write(blob)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def read_secure(path: str):
    """Decrypted text, or None if missing/undecryptable. Legacy plaintext files are returned as-is."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return None
    if raw.startswith(MAGIC):
        try:
            return unprotect(raw[len(MAGIC):]).decode("utf-8")
        except Exception:
            return None
    try:
        return raw.decode("utf-8-sig")       # legacy plaintext cache
    except UnicodeDecodeError:
        return None


def is_encrypted(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(len(MAGIC)) == MAGIC
    except OSError:
        return False
