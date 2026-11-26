from io import BytesIO

import pytest
from PIL import Image

from app.services import image_service
from app.services.image_service import ImageTooLarge, InvalidImage, reencode


def picture(fmt="JPEG", size=(80, 40), mode="RGB", exif=None):
    buffer = BytesIO()
    Image.new(mode, size).save(buffer, format=fmt, **({"exif": exif} if exif else {}))
    return buffer.getvalue()


def opened(data):
    return Image.open(BytesIO(data))


def test_gps_and_other_metadata_are_removed():
    exif = Image.Exif()
    exif[0x010F] = "PhoneMaker"
    exif[0x8825] = {1: "N", 2: (40.0, 25.0, 0.0)}
    source = picture(exif=exif.tobytes())
    assert opened(source).getexif()

    result = opened(reencode(source, 1600))

    assert result.format == "WEBP"
    assert not result.getexif()
    assert "exif" not in result.info


def test_exif_rotation_is_applied_before_it_is_dropped():
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees
    assert opened(reencode(picture(exif=exif.tobytes()), 1600)).size == (40, 80)


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
def test_supported_formats(fmt):
    assert opened(reencode(picture(fmt), 1600)).format == "WEBP"


@pytest.mark.parametrize("data", [b"", b"hello", picture("GIF", mode="P"), b"\xff\xd8\xff" + b"junk" * 20])
def test_anything_else_is_rejected(data):
    with pytest.raises(InvalidImage):
        reencode(data, 1600)


def test_a_decompression_bomb_is_rejected():
    with pytest.raises(ImageTooLarge):
        reencode(picture("PNG", size=(10000, 10000), mode="1"), 1600)


def test_an_upload_over_the_limit_is_rejected():
    class Upload:
        file = BytesIO(b"x" * 11)

    with pytest.raises(ImageTooLarge):
        image_service.read_upload(Upload(), max_bytes=10)


def test_avatars_are_small_squares_and_photos_are_bounded():
    assert opened(reencode(picture(size=(2000, 1000)), 512, square=True)).size == (512, 512)
    assert opened(reencode(picture(size=(100, 60)), 512, square=True)).size == (60, 60)
    assert opened(reencode(picture(size=(3200, 1600)), 1600)).size == (1600, 800)
