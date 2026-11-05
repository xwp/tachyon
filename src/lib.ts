import { S3Client, S3ClientConfig, GetObjectCommand, GetObjectCommandOutput } from '@aws-sdk/client-s3';
import sharp, { OutputInfo } from 'sharp';
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
	} ).withMetadata();

	// check we can get valid metadata
	const metadata = await image.metadata();

	let width = metadata.width as number;
	let height = metadata.height as number;

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

	// get zoom value
	const zoom = parseFloat( args.zoom || '1' ) || 1;

	// resize
	if ( args.resize ) {
		// apply smart crop if available
		if ( args.crop_strategy === 'smart' && ! args.crop ) {
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
		const newWidth = Number(args.w);
        const aspectRatio = height / width;
        width = newWidth;
        height = Math.round(newWidth * aspectRatio);
		image.resize( {
			width: newWidth * zoom || undefined,
			height: Number( args.h ) * zoom || undefined,
			fit: args.crop ? 'cover' : 'inside',
			withoutEnlargement: true,
		} );
	}

	// `crop=1` is a flag for the `w`/`h` center crop above, not a region.
	if (args.crop && args.crop !== '1') {
		const cropValuesString = typeof args.crop === 'string' ? args.crop.split(',') : args.crop;

		// convert percentages to px values
		const cropValues = cropValuesString.map((value, index) => {
			if (value.endsWith('px')) {
				return Number(value.slice(0, -2));
			} else {
				const dimension = index % 2 === 0 ? 'width' : 'height';
				return Math.round((metadata[dimension] as number) * (Number(value) / 100));
			}
		});

		const [x, y, w, h] = cropValues;

		// Ensure crop dimensions don't exceed image boundaries
		const extractWidth = Math.min(w, width - x);
		const extractHeight = Math.min(h, height - y);

		image.extract({
			left: x,
			top: y,
			width: extractWidth,
			height: extractHeight
		});
	}

	// set default quality slightly higher than sharp's default
	if ( ! args.quality ) {
		args.quality = applyZoomCompression( 82, zoom );
	}

	// allow override of compression quality
	if ( args.avif ) {
		image.avif( {
			quality: Math.round( clamp( args.quality, 0, 100 ) ),
		} );
	} else if ( args.webp ) {
		image.webp( {
			quality: Math.round( clamp( args.quality, 0, 100 ) ),
		} );
	} else if ( metadata.format === 'jpeg' ) {
		image.jpeg( {
			quality: Math.round( clamp( args.quality, 0, 100 ) ),
		} );
	} else if ( metadata.format === 'png' ) {
		// Compress the PNG.
		image.png( {
			palette: true,
		} );
	}

	// send image
	return new Promise( ( resolve, reject ) => {
		image.toBuffer( async ( err, data, info ) => {
			if ( err ) {
				reject( err );
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
