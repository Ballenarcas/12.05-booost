"""Checks and re-encodes uploaded photos. Only the re-encoded bytes are ever stored."""

from io import BytesIO
from typing import Any

from PIL import Image, ImageOps

MAX_IMAGE_BYTES = 8 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_PIXELS = 40_000_000


class InvalidImage(Exception):
    pass


class ImageTooLarge(Exception):
    pass


def looks_like_image(data: bytes) -> bool:
    if data.startswith(b"\xff\xd8\xff"):
        return True
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return True
    return data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def read_upload(upload: Any, max_bytes: int = MAX_IMAGE_BYTES) -> bytes:
    data = upload.file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ImageTooLarge()
    return data


def reencode(data: bytes, max_side: int, square: bool = False) -> bytes:
    """A fresh WebP built from the pixels alone, so no EXIF, GPS or hidden payload survives."""
    if len(data) > MAX_IMAGE_BYTES:
        raise ImageTooLarge()
    if not looks_like_image(data):
        raise InvalidImage()
    try:
        with Image.open(BytesIO(data), formats=["JPEG", "PNG", "WEBP"]) as source:
            # Checked before the pixels are decoded.
            if source.width * source.height > MAX_IMAGE_PIXELS:
                raise ImageTooLarge()
            image = ImageOps.exif_transpose(source).convert("RGB")
        if square:
            side = min(max_side, *image.size)
            image = ImageOps.fit(image, (side, side))
        else:
            image.thumbnail((max_side, max_side))
        clean = Image.new("RGB", image.size)
        clean.paste(image)
        output = BytesIO()
        clean.save(output, format="WEBP", quality=85)
    except Image.DecompressionBombError as error:
        raise ImageTooLarge() from error
    except (OSError, SyntaxError, ValueError) as error:
        raise InvalidImage() from error
    return output.getvalue()
