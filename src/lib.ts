import { S3Client, S3ClientConfig, GetObjectCommand, GetObjectCommandOutput } from '@aws-sdk/client-s3';
import sharp, { FormatEnum, OutputInfo, Sharp } from 'sharp';
import smartcrop from 'smartcrop-sharp';

export interface Args {
	// Optional args.
	background?: string;
	crop?: string | string[];
	crop_strategy?: string;
	fit?: string;
	gravity?: string;
	h?: string;
	lb?: string;
	resize?: string | number[];
	quality?: string | number;
	strip?: string;
	brightness?: string;
	contrast?: string;
	colorize?: string;
	smooth?: string;
	filter?: string;
	ulb?: string;
	w?: string;
	webp?: string | boolean;
	zoom?: string;
	avif?: string | boolean;
	'X-Amz-Algorithm'?: string;
	'X-Amz-Content-Sha256'?: string;
	'X-Amz-Credential'?: string;
	'X-Amz-SignedHeaders'?: string;
	'X-Amz-Expires'?: string;
	'X-Amz-Signature'?: string;
	'X-Amz-Date'?: string;
	'X-Amz-Security-Token'?: string;
	'x-amz-checksum-mode'?: string;
}

export type Config = S3ClientConfig & { bucket: string };

/**
 * Get the dimensions from a string or array of strings.
 */
function getDimArray( dims: string | number[], zoom: number = 1 ): ( number | null )[] {
	let dimArr = typeof dims === 'string' ? dims.split( ',' ) : dims;
	return dimArr.map( v => Math.round( Number( v ) * zoom ) || null );
}

/**
 * Clamp a value between a min and max.
 */
function clamp( val: number | string, min: number, max: number ): number {
	return Math.min( Math.max( Number( val ), min ), max );
}

/**
 * Whether a query arg value is a boolean flag (Photon uses 1/0/true/false).
 */
export function isBooleanArg( value: unknown ): boolean {
	return typeof value === 'boolean' || /^(0|1|true|false)$/i.test( String( value ) );
}

/**
 * Parse a boolean query arg. An empty value (e.g. `?original`) counts as true.
 */
export function parseBooleanArg( value: unknown ): boolean {
	if ( typeof value === 'boolean' ) {
		return value;
	}
	return ! /^(0|false)$/i.test( String( value ) );
}

/**
 * Whether sharp can parse a colour, e.g. `red`, `#fff` or `#ff0000`.
 */
function isValidColor( value: string ): boolean {
	try {
		sharp().resize( { width: 1, background: value } );
		return true;
	} catch {
		return false;
	}
}

/**
 * Convert a Photon crop (`x,y,w,h` as percentages or `px` values) to a
 * pixel region clamped to the image. Returns null if nothing is left.
 */
export function getCropRegion(
	crop: string | string[],
	imageWidth: number,
	imageHeight: number
): { left: number; top: number; width: number; height: number } | null {
	const values = ( typeof crop === 'string' ? crop.split( ',' ) : crop ).map( ( value, index ) => {
		if ( value.endsWith( 'px' ) ) {
			return Number( value.slice( 0, -2 ) );
		}
		const dimension = index % 2 === 0 ? imageWidth : imageHeight;
		return Math.round( dimension * ( Number( value ) / 100 ) );
	} );

	const left = Math.min( Math.max( values[0], 0 ), imageWidth );
	const top = Math.min( Math.max( values[1], 0 ), imageHeight );
	const width = Math.min( values[2], imageWidth - left );
	const height = Math.min( values[3], imageHeight - top );

	if ( width < 1 || height < 1 ) {
		return null;
	}
	return { left, top, width, height };
}

/**
 * Apply Photon's `strip` arg. Orientation is always applied to the pixels
 * first (see `rotate()`), so no mode keeps the EXIF orientation tag.
 *
 * - `all` (default): remove EXIF, XMP, IPTC and the ICC profile. sharp
 *   converts the pixels to sRGB first, so colours stay correct.
 * - `none`: keep all metadata.
 * - `info`: remove EXIF, XMP and IPTC, keep the ICC colour profile.
 * - `color`: keep EXIF and XMP, remove the ICC colour profile.
 */
function applyStrip( image: Sharp, strip: string = 'all' ): void {
	switch ( strip ) {
		case 'none':
			image.keepMetadata();
			break;
		case 'info':
			image.keepIccProfile();
			break;
		case 'color':
			image.keepExif().keepXmp();
			break;
	}
}

/**
 * Whether a value is an integer string within a range.
 */
function isIntegerInRange( value: string, min: number, max: number ): boolean {
	return /^-?\d{1,3}$/.test( value ) && Number( value ) >= min && Number( value ) <= max;
}

/**
 * A step applied to the colour channels of 8-bit pixels. Each step's
 * output is clipped to 0-255 before the next, as PHP GD does per filter.
 */
type PixelOp =
	| { type: 'linear'; a: number[]; b: number[] }
	| { type: 'recomb'; matrix: [ number, number, number ][] }
	| { type: 'convolve'; convolution: Convolution };

/**
 * 3x3 convolution kernels for Photon filters, copied from PHP GD's
 * imagefilter(), which Photon uses. blurselective has no exact sharp
 * equivalent (GD blurs only where neighbours are similar), so it is a
 * light blur that keeps more of each pixel.
 */
const FILTER_KERNELS: Record<string, Omit<Convolution, 'width' | 'height'>> = {
	edgedetect: { kernel: [ -1, 0, -1, 0, 4, 0, -1, 0, -1 ], scale: 1, offset: 127 },
	emboss: { kernel: [ 1.5, 0, 0, 0, 0, 0, 0, 0, -1.5 ], scale: 1, offset: 127 },
	meanremoval: { kernel: [ -1, -1, -1, -1, 9, -1, -1, -1, -1 ], scale: 1, offset: 0 },
	blurgaussian: { kernel: [ 1, 2, 1, 2, 4, 2, 1, 2, 1 ], scale: 16, offset: 0 },
	blurselective: { kernel: [ 1, 1, 1, 1, 8, 1, 1, 1, 1 ], scale: 16, offset: 0 },
};

const LUMINANCE: [ number, number, number ] = [ 0.299, 0.587, 0.114 ];

/**
 * Photon's brightness, contrast, colorize, smooth and filter args as pixel
 * steps, in that order. Photon uses PHP GD's imagefilter(), so these copy GD:
 * - brightness: add the value to each colour channel.
 * - contrast: scale around mid-grey. GD's sign is inverted, so Photon's
 *   value c gives the factor ((100 + c) / 100)^2.
 * - colorize: add r,g,b to the matching channels.
 * - smooth: 3x3 kernel, centre weight w, divided by 8 + w.
 * - filter: negate inverts, grayscale uses luminance, sepia is grayscale
 *   then colorize 100,50,0, and the rest are the 3x3 FILTER_KERNELS.
 */
function getPixelOps( args: Args ): PixelOp[] {
	const ops: PixelOp[] = [];
	if ( args.brightness && Number( args.brightness ) !== 0 ) {
		const value = Number( args.brightness );
		ops.push( { type: 'linear', a: [ 1, 1, 1 ], b: [ value, value, value ] } );
	}
	if ( args.contrast && Number( args.contrast ) !== 0 ) {
		const factor = ( ( 100 + Number( args.contrast ) ) / 100 ) ** 2;
		const offset = 127.5 * ( 1 - factor );
		ops.push( { type: 'linear', a: [ factor, factor, factor ], b: [ offset, offset, offset ] } );
	}
	if ( args.colorize ) {
		const rgb = args.colorize.split( ',' ).map( Number );
		if ( rgb.some( value => value !== 0 ) ) {
			ops.push( { type: 'linear', a: [ 1, 1, 1 ], b: rgb } );
		}
	}
	if ( args.smooth ) {
		const weight = Number( args.smooth );
		ops.push( {
			type: 'convolve',
			convolution: { width: 3, height: 3, kernel: [ 1, 1, 1, 1, weight, 1, 1, 1, 1 ], scale: 8 + weight, offset: 0 },
		} );
	}
	switch ( args.filter ) {
		case 'negate':
			ops.push( { type: 'linear', a: [ -1, -1, -1 ], b: [ 255, 255, 255 ] } );
			break;
		case 'grayscale':
			ops.push( { type: 'recomb', matrix: [ LUMINANCE, LUMINANCE, LUMINANCE ] } );
			break;
		case 'sepia':
			ops.push( { type: 'recomb', matrix: [ LUMINANCE, LUMINANCE, LUMINANCE ] } );
			ops.push( { type: 'linear', a: [ 1, 1, 1 ], b: [ 100, 50, 0 ] } );
			break;
		default: {
			const kernel = args.filter ? FILTER_KERNELS[args.filter] : undefined;
			if ( kernel ) {
				ops.push( { type: 'convolve', convolution: { width: 3, height: 3, ...kernel } } );
			}
		}
	}
	return ops;
}

type Convolution = { width: number; height: number; kernel: number[]; scale: number; offset: number };


/**
 * Apply pixel steps to the colour channels of raw 8-bit pixels, one frame
 * at a time. Alpha is not changed.
 *
 * sharp's convolve() also filters alpha, runs across the stacked frames of
 * an animation, and sharp keeps only one linear() and one convolve() per
 * pipeline without clipping between them. GD (and so Photon) applies each
 * filter to colour only and clips after each one.
 */
async function applyPixelOps(
	data: Buffer,
	width: number,
	height: number,
	channels: 1 | 2 | 3 | 4,
	pageHeight: number,
	ops: PixelOp[]
): Promise<Buffer> {
	const colourBands = ( channels === 2 || channels === 4 ? channels - 1 : channels ) as 1 | 2 | 3 | 4;
	const frameBytes = width * pageHeight * channels;
	const out = Buffer.from( data );

	for ( let top = 0; top < height; top += pageHeight ) {
		const start = ( top / pageHeight ) * frameBytes;
		let frame = sharp( data.subarray( start, start + frameBytes ), {
			raw: { width, height: pageHeight, channels },
			limitInputPixels: false,
		} );
		if ( colourBands !== channels ) {
			frame.removeAlpha();
		}
		let pixels = await frame.raw().toBuffer();
		for ( const op of ops ) {
			frame = sharp( pixels, { raw: { width, height: pageHeight, channels: colourBands }, limitInputPixels: false } );
			if ( op.type === 'linear' ) {
				frame.linear( op.a.slice( 0, colourBands ), op.b.slice( 0, colourBands ) );
			} else if ( op.type === 'recomb' ) {
				frame.recomb( op.matrix as [ [ number, number, number ], [ number, number, number ], [ number, number, number ] ] );
			} else {
				frame.convolve( op.convolution );
			}
			pixels = await frame.raw( { depth: 'uchar' } ).toBuffer();
		}
		for ( let pixel = 0; pixel < width * pageHeight; pixel++ ) {
			for ( let band = 0; band < colourBands; band++ ) {
				out[start + pixel * channels + band] = pixels[pixel * colourBands + band];
			}
		}
	}
	return out;
}

/**
 * Get a file from S3/
 */
export async function getS3File( config: Config, key: string, args: Args ): Promise<GetObjectCommandOutput> {
	const s3 = new S3Client( {
		...config,
		// Opt out of default integrity protection (WHEN_SUPPORTED, added in
		// @aws-sdk/client-s3 ~3.730). The auto-added checksum headers/query
		// params break our reuse of the caller's presigned signature below.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
		signer: {
			/**
			 *
			 * @param request
			 */
			sign: async request => {
				if ( ! args['X-Amz-Algorithm'] ) {
					return request;
				}
				const presignedParamNames = [
					'X-Amz-Algorithm',
					'X-Amz-Content-Sha256',
					'X-Amz-Credential',
					'X-Amz-SignedHeaders',
					'X-Amz-Expires',
					'X-Amz-Signature',
					'X-Amz-Date',
					'X-Amz-Security-Token',
					// Signed by @aws-sdk/s3-request-presigner >= ~3.730.
					'x-amz-checksum-mode',
				] as const;
				const presignedParams: { [K in ( typeof presignedParamNames )[number]]?: string } = {}; // eslint-disable-line no-unused-vars
				const signedHeaders = ( args['X-Amz-SignedHeaders']?.split( ';' ) || [] ).map( header => header.toLowerCase().trim() );

				for ( const paramName of presignedParamNames ) {
					if ( args[paramName] ) {
						presignedParams[paramName] = args[paramName];
					}
				}

				const headers: typeof request.headers = {};
				for ( const header in request.headers ) {
					if ( signedHeaders.includes( header.toLowerCase() ) ) {
						headers[header] = request.headers[header];
					}
				}
				request.query = presignedParams;

				request.headers = headers;
				return request;
			},
		},
	} );

	const command = new GetObjectCommand( {
		Bucket: config.bucket,
		Key: key,
	} );

	return s3.send( command );
}

/**
 * Apply a logarithmic compression to a value based on a zoom level.
 * return a default compression value based on a logarithmic scale
 * defaultValue = 100, zoom = 2; = 65
 * defaultValue = 80, zoom = 2; = 50
 * defaultValue = 100, zoom = 1.5; = 86
 * defaultValue = 80, zoom = 1.5; = 68
 */
function applyZoomCompression( defaultValue: number, zoom: number ): number {
	const value = Math.round( defaultValue - ( Math.log( zoom ) / Math.log( defaultValue / zoom ) ) * ( defaultValue * zoom ) );
	const min = Math.round( defaultValue / zoom );
	return clamp( value, min, defaultValue );
}

type ResizeBufferResult = {
	data: Buffer;
	info: OutputInfo & {
		errors: string;
	}
};

/**
 * Resize a buffer of an image.
 */
export async function resizeBuffer(
	buffer: Buffer | Uint8Array,
	args: Args
): Promise<ResizeBufferResult> {
	const image = sharp( buffer, {
		failOn: 'none',
		animated: true,
		limitInputPixels: false,
	} );

	// check we can get valid metadata
	const metadata = await image.metadata();

	// Dimensions after EXIF auto-orientation, which is what crop coordinates refer to.
	let width = ( metadata.autoOrient?.width ?? metadata.width ) as number;
	let height = ( metadata.autoOrient?.height ?? metadata.height ) as number;

	// auto rotate based on orientation EXIF data.
	image.rotate();

	// validate args, remove from the object if not valid
	const errors: string[] = [];

	if ( args.w ) {
		if ( ! /^[1-9]\d*$/.test( args.w ) ) {
			delete args.w;
			errors.push( 'w arg is not valid' );
		}
	}
	if ( args.h ) {
		if ( ! /^[1-9]\d*$/.test( args.h ) ) {
			delete args.h;
			errors.push( 'h arg is not valid' );
		}
	}
	if ( args.quality ) {
		const quality = Number( args.quality );
		// Photon accepts 10-100.
		if ( ! /^\d{1,3}$/.test( String( args.quality ) ) || quality < 10 || quality > 100 ) {
			delete args.quality;
			errors.push( 'quality arg is not valid' );
		}
	}
	if ( args.resize ) {
		if ( ! /^\d+(px)?,\d+(px)?$/.test( args.resize as string ) ) {
			delete args.resize;
			errors.push( 'resize arg is not valid' );
		}
	}
	if ( args.crop_strategy ) {
		if ( ! /^(smart|entropy|attention)$/.test( args.crop_strategy ) ) {
			delete args.crop_strategy;
			errors.push( 'crop_strategy arg is not valid' );
		}
	}
	if ( args.gravity ) {
		if ( ! /^(north|northeast|east|southeast|south|southwest|west|northwest|center)$/.test( args.gravity ) ) {
			delete args.gravity;
			errors.push( 'gravity arg is not valid' );
		}
	}
	if ( args.fit ) {
		if ( ! /^\d+(px)?,\d+(px)?$/.test( args.fit as string ) ) {
			delete args.fit;
			errors.push( 'fit arg is not valid' );
		}
	}
	if ( args.crop ) {
		if ( isBooleanArg( args.crop ) ) {
			// Photon's `crop=1` with `w` and `h` means a center crop to that box.
			if ( parseBooleanArg( args.crop ) ) {
				args.crop = '1';
			} else {
				delete args.crop;
			}
		} else if ( ! /^(\d+px|\d+(\.\d+)?)(,(\d+px|\d+(\.\d+)?)){3}$/.test( args.crop as string ) ) {
			// Pixel values must be integers; percentages may be fractional.
			delete args.crop;
			errors.push( 'crop arg is not valid' );
		}
	}
	if ( args.zoom ) {
		// Photon accepts 1-10.
		if ( ! /^\d+(\.\d+)?$/.test( args.zoom ) || Number( args.zoom ) < 1 || Number( args.zoom ) > 10 ) {
			delete args.zoom;
			errors.push( 'zoom arg is not valid' );
		}
	}
	if ( typeof args.webp !== 'undefined' ) {
		if ( isBooleanArg( args.webp ) ) {
			args.webp = parseBooleanArg( args.webp );
		} else {
			delete args.webp;
			errors.push( 'webp arg is not valid' );
		}
	}
	if ( typeof args.avif !== 'undefined' ) {
		if ( isBooleanArg( args.avif ) ) {
			args.avif = parseBooleanArg( args.avif );
		} else {
			delete args.avif;
			errors.push( 'avif arg is not valid' );
		}
	}
	if ( args.lb ) {
		if ( ! /^\d+(px)?,\d+(px)?$/.test( args.lb ) ) {
			delete args.lb;
			errors.push( 'lb arg is not valid' );
		}
	}
	if ( args.background ) {
		if ( ! isValidColor( args.background ) ) {
			delete args.background;
			errors.push( 'background arg is not valid' );
		}
	}

	if ( typeof args.strip !== 'undefined' ) {
		if ( ! /^(all|none|info|color)$/.test( args.strip ) ) {
			delete args.strip;
			errors.push( 'strip arg is not valid' );
		}
	}
	applyStrip( image, args.strip );

	if ( typeof args.brightness !== 'undefined' ) {
		if ( ! isIntegerInRange( args.brightness, -255, 255 ) ) {
			delete args.brightness;
			errors.push( 'brightness arg is not valid' );
		}
	}
	if ( typeof args.contrast !== 'undefined' ) {
		if ( ! isIntegerInRange( args.contrast, -100, 100 ) ) {
			delete args.contrast;
			errors.push( 'contrast arg is not valid' );
		}
	}
	if ( typeof args.colorize !== 'undefined' ) {
		const parts = args.colorize.split( ',' );
		if ( parts.length !== 3 || ! parts.every( part => isIntegerInRange( part, -255, 255 ) ) ) {
			delete args.colorize;
			errors.push( 'colorize arg is not valid' );
		}
	}
	if ( typeof args.smooth !== 'undefined' ) {
		// Photon: values near 2048 or more have little effect, so cap it.
		if ( ! /^\d{1,5}(\.\d+)?$/.test( args.smooth ) || Number( args.smooth ) > 10000 ) {
			delete args.smooth;
			errors.push( 'smooth arg is not valid' );
		}
	}

	if ( typeof args.filter !== 'undefined' ) {
		if ( ! Object.prototype.hasOwnProperty.call( FILTER_KERNELS, args.filter ) && ! /^(negate|grayscale|sepia)$/.test( args.filter ) ) {
			delete args.filter;
			errors.push( 'filter arg is not valid' );
		}
	}
	if ( typeof args.ulb !== 'undefined' ) {
		if ( args.ulb !== 'true' ) {
			delete args.ulb;
			errors.push( 'ulb arg is not valid' );
		}
	}

	// get zoom value
	const zoom = parseFloat( args.zoom || '1' ) || 1;

	// Remove a black letterbox. sharp runs trim before extract, so crop
	// coordinates refer to the trimmed image. Measure it so the crop is
	// clamped to the right size.
	if ( args.ulb && ( width < 3 || height < 3 ) ) {
		// sharp cannot trim images smaller than 3x3; there is no letterbox.
		delete args.ulb;
	}
	if ( args.ulb && ( metadata.pages ?? 1 ) > 1 ) {
		// sharp cannot trim multi-page (animated) images.
		delete args.ulb;
		errors.push( 'ulb is not supported for animated images' );
	}
	if ( args.ulb ) {
		image.trim( { background: '#000000', threshold: 10 } );
		const { info } = await image.clone().raw().toBuffer( { resolveWithObject: true } );
		width = info.width;
		height = info.pageHeight ?? info.height;
	}

	// Crop first, on the source image, as Photon does. `crop=1` is only a
	// flag for the `w`/`h` center crop below, not a region.
	let hasCropRegion = false;
	if ( args.crop && args.crop !== '1' ) {
		const region = getCropRegion( args.crop as string | string[], width, height );
		if ( region ) {
			image.extract( region );
			hasCropRegion = true;
		} else {
			delete args.crop;
			errors.push( 'crop arg is outside the image' );
		}
	}

	// resize
	if ( args.resize ) {
		// apply smart crop if available
		if ( args.crop_strategy === 'smart' && ! hasCropRegion ) {
			const cropResize = getDimArray( args.resize );
			const rotatedImage = await image.toBuffer();
			const result = await smartcrop.crop( rotatedImage, {
				width: cropResize[0] as number,
				height: cropResize[1] as number,
			} );

			if ( result && result.topCrop ) {
				image.extract( {
					left: result.topCrop.x,
					top: result.topCrop.y,
					width: result.topCrop.width,
					height: result.topCrop.height,
				} );
			}
		}

		// apply the resize
		args.resize = getDimArray( args.resize, zoom ) as number[];
		image.resize( {
			width: args.resize[0],
			height: args.resize[1],
			withoutEnlargement: true,
			position: ( args.crop_strategy !== 'smart' && args.crop_strategy ) || args.gravity || 'centre',
		} );
	} else if ( args.fit ) {
		const fit = getDimArray( args.fit, zoom ) as number[];
		image.resize( {
			width: fit[0],
			height: fit[1],
			fit: 'inside',
			withoutEnlargement: true,
		} );
	} else if ( args.lb ) {
		const lb = getDimArray( args.lb, zoom ) as number[];
		image.resize( {
			width: lb[0],
			height: lb[1],
			fit: 'contain',
			// default to a black background to replicate Photon API behavior
			// when no background colour specified
			background: args.background || 'black',
			withoutEnlargement: true,
		} );
	} else if ( args.w || args.h ) {
		image.resize( {
			width: Number( args.w ) * zoom || undefined,
			height: Number( args.h ) * zoom || undefined,
			fit: args.crop === '1' ? 'cover' : 'inside',
			withoutEnlargement: true,
		} );
	}


	// set default quality slightly higher than sharp's default
	if ( ! args.quality ) {
		args.quality = applyZoomCompression( 82, zoom );
	}

	// allow override of compression quality
	const encode = ( output: Sharp ): Sharp => {
		if ( args.avif ) {
			return output.avif( {
				quality: Math.round( clamp( args.quality!, 0, 100 ) ),
			} );
		} else if ( args.webp ) {
			return output.webp( {
				quality: Math.round( clamp( args.quality!, 0, 100 ) ),
			} );
		} else if ( metadata.format === 'jpeg' ) {
			return output.jpeg( {
				quality: Math.round( clamp( args.quality!, 0, 100 ) ),
			} );
		} else if ( metadata.format === 'png' ) {
			// Compress the PNG.
			return output.png( {
				palette: true,
			} );
		}
		return output;
	};

	const pixelOps = getPixelOps( args );
	if ( pixelOps.length ) {
		// Stage 1: everything else, as raw 8-bit sRGB pixels. sRGB gives
		// greyscale input three bands for colorize, and converts CMYK and
		// 16-bit input through the normal colour management. Stage 2: the
		// pixel steps per frame and colour only, then encode.
		const sourceFormat = metadata.format as keyof FormatEnum;
		const raw = await image.toColourspace( 'srgb' ).raw( { depth: 'uchar' } ).toBuffer( { resolveWithObject: true } );
		const pageHeight = raw.info.pageHeight ?? raw.info.height;
		const processed = await applyPixelOps(
			raw.data,
			raw.info.width,
			raw.info.height,
			raw.info.channels,
			pageHeight,
			pixelOps
		);
		const output = sharp( processed, {
			limitInputPixels: false,
			raw: {
				width: raw.info.width,
				height: raw.info.height,
				channels: raw.info.channels,
				pageHeight,
			},
		} );
		// Raw pixels carry no metadata, so this output is always stripped.
		if ( args.strip && args.strip !== 'all' ) {
			errors.push( 'strip is not supported with brightness, contrast, colorize, smooth or filter' );
		}
		const animation = pageHeight !== raw.info.height ? { loop: metadata.loop, delay: metadata.delay } : {};
		if ( ! args.avif && ! args.webp && ! [ 'jpeg', 'png' ].includes( metadata.format ?? '' ) ) {
			// Match the format sharp picks when no format is set. Raw input
			// has no source format, so it must be set here.
			if ( sourceFormat === 'heif' ) {
				// AVIF is the HEIF variant sharp can encode.
				output.avif();
			} else if ( [ 'gif', 'webp', 'tiff' ].includes( sourceFormat ) ) {
				output.toFormat( sourceFormat, animation );
			} else {
				// e.g. svg, which sharp writes as png.
				output.png();
			}
		} else if ( args.webp ) {
			output.webp( animation );
		}
		const { data, info } = await encode( output ).toBuffer( { resolveWithObject: true } );
		return {
			data,
			info: {
				...info,
				errors: errors.join( ';' ),
			},
		};
	}

	encode( image );

	// send image
	return new Promise( ( resolve, reject ) => {
		image.toBuffer( async ( err, data, info ) => {
			if ( err ) {
				reject( err );
				return;
			}

			// add invalid args
			resolve( {
				data,
				info: {
					...info,
					errors: errors.join( ';' ),
				},
			} );
		} );
	} );
}
