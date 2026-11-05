# Using

Tachyon provides a simple HTTP interface in the form of:

`https://{tachyon-domain}/my/image/path/on/s3.png?w=100&h=80`

It's really that simple!

## Args Reference

| URL Arg | Type | Description |
|---|----|---|
|`w`|Number|Max width of the image.|
|`h`|Number|Max height of the image.|
|`quality`|Number, 10-100|Image quality. Values outside 10-100 are ignored.|
|`resize`|String, "w,h"|A comma separated string of the target width and height in pixels. Crops the image.|
|`crop_strategy`|String, "smart", "entropy", "attention"|There are 3 automatic cropping strategies for use with `resize`: <ul><li>`attention`: good results, ~70% slower</li><li>`entropy`: mediocre results, ~30% slower</li><li>`smart`: best results, ~50% slower</li>|
|`gravity`|String|Alternative to `crop_strategy`. Crops are made from the center of the image by default, passing one of "north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest" or "center" will crop from that edge.|
|`fit`|String, "w,h"|A comma separated string of the target maximum width and height. Does not crop the image.|
|`crop`|Boolean\|String, "x,y,w,h"|`crop=1` with `w` and `h` crops from the center to exactly that size. Otherwise, crop an image by percentages x-offset, y-offset, width and height (x,y,w,h). Percentages are used so that you don’t need to recalculate the cropping when transforming the image in other ways such as resizing it. The crop is applied to the source image (after EXIF rotation) before any resize, as in Photon. You can crop by pixel values too by appending `px` to the values. `crop=160px,160px,788px,788px` takes a 788 by 788 pixel square starting at 160 by 160.|
|`zoom`|Number, 1-10|Zooms the image by the specified amount for high DPI displays. `zoom=2` produces an image twice the size specified in `w`, `h`, `fit` or `resize`. The quality is automatically reduced to keep file sizes roughly equivalent to the non-zoomed image unless the `quality` argument is passed.|
|`webp`|Boolean, 0/1/true/false|On by default. Pass `webp=0` or `original` to keep the source format.|
|`original`|Boolean, 1|Keep the source format and skip WebP. `original=0` has no effect.|
|`lb`|String, "w,h"|Add letterboxing effect to images, by scaling them to width, height while maintaining the aspect ratio and filling the rest with black or `background`.|
|`background`|String|Background colour for `lb`, as a name (`red`) or hex value (`%23ff0000`, `%23fff`). Escape `#` as `%23`.|
|`strip`|String, "all", "none", "info", "color"|Controls metadata in the output. `all` (default) removes EXIF, IPTC, XMP and the colour profile after converting to sRGB. `none` keeps everything. `info` keeps only the colour profile. `color` keeps EXIF and XMP but removes the colour profile. EXIF orientation is always applied to the pixels first.|
