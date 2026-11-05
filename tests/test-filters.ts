import { describe, expect, test } from '@jest/globals';
import sharp from 'sharp';

import fs from 'fs';

import { Args, resizeBuffer } from '../src/lib';

/**
 * A solid 8x8 PNG of one colour, optionally with alpha.
 */
function solid( r: number, g: number, b: number, alpha?: number ): Promise<Buffer> {
	const channels = typeof alpha === 'undefined' ? 3 : 4;
	const background = channels === 4 ? { r, g, b, alpha } : { r, g, b };
	return sharp( { create: { width: 8, height: 8, channels, background } } ).png().toBuffer();
}

/**
 * Process an image as PNG (lossless) and return the output info and centre pixel.
 */
async function run( input: Buffer, args: Args ) {
	const result = await resizeBuffer( input, { ...args, webp: false } );
	const { data, info } = await sharp( result.data ).raw().toBuffer( { resolveWithObject: true } );
	const i = ( Math.floor( info.height / 2 ) * info.width + Math.floor( info.width / 2 ) ) * info.channels;
	return {
		errors: result.info.errors,
		width: info.width,
		height: info.height,
		pixel: Array.from( data.subarray( i, i + info.channels ) ),
	};
}

describe( 'filter', () => {
	test( 'negate inverts colour and keeps alpha', async () => {
		const { errors, pixel } = await run( await solid( 200, 100, 0, 0.5 ), { filter: 'negate' } );
		expect( errors ).toBe( '' );
		expect( pixel.slice( 0, 3 ) ).toEqual( [ 55, 155, 255 ] );
		expect( Math.abs( pixel[3] - 128 ) ).toBeLessThanOrEqual( 1 );
	} );

	test( 'grayscale removes colour', async () => {
		const { pixel } = await run( await solid( 200, 100, 0 ), { filter: 'grayscale' } );
		expect( new Set( pixel.slice( 0, 3 ) ).size ).toBe( 1 );
	} );

	test( 'sepia is a warm tint', async () => {
		const { pixel } = await run( await solid( 100, 100, 100 ), { filter: 'sepia' } );
		expect( pixel[0] ).toBeGreaterThan( pixel[1] );
		expect( pixel[1] ).toBeGreaterThan( pixel[2] );
	} );

	test( 'sepia keeps alpha', async () => {
		const { pixel } = await run( await solid( 100, 100, 100, 0.5 ), { filter: 'sepia' } );
		expect( pixel ).toHaveLength( 4 );
		expect( Math.abs( pixel[3] - 128 ) ).toBeLessThanOrEqual( 1 );
	} );

	test( 'edgedetect turns a flat image into mid-grey', async () => {
		const { pixel } = await run( await solid( 200, 100, 0 ), { filter: 'edgedetect' } );
		pixel.forEach( value => expect( Math.abs( value - 127 ) ).toBeLessThanOrEqual( 1 ) );
	} );

	test( 'emboss turns a flat image into mid-grey', async () => {
		const { pixel } = await run( await solid( 200, 100, 0 ), { filter: 'emboss' } );
		pixel.forEach( value => expect( Math.abs( value - 127 ) ).toBeLessThanOrEqual( 1 ) );
	} );

	test.each( [ 'meanremoval', 'blurgaussian', 'blurselective' ] )( '%s leaves a flat image unchanged', async filter => {
		const { errors, pixel } = await run( await solid( 200, 100, 0 ), { filter } );
		expect( errors ).toBe( '' );
		expect( pixel ).toEqual( [ 200, 100, 0 ] );
	} );

	test.each( [ 'edgedetect', 'emboss', 'meanremoval', 'blurgaussian' ] )( '%s keeps alpha', async filter => {
		const { pixel } = await run( await solid( 200, 100, 0, 0.5 ), { filter } );
		expect( pixel ).toHaveLength( 4 );
		expect( Math.abs( pixel[3] - 128 ) ).toBeLessThanOrEqual( 1 );
	} );

	test( 'blurgaussian softens an edge', async () => {
		// Left half black, right half white.
		const input = await sharp( {
			create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } },
		} )
			.composite( [ {
				input: { create: { width: 4, height: 8, channels: 3, background: { r: 255, g: 255, b: 255 } } },
				left: 4,
				top: 0,
			} ] )
			.png()
			.toBuffer();
		const { pixel } = await run( input, { filter: 'blurgaussian' } );
		expect( pixel[0] ).toBeGreaterThan( 0 );
		expect( pixel[0] ).toBeLessThan( 255 );
	} );

	test( 'blurselective softens a single bright pixel', async () => {
		const input = await sharp( { create: { width: 5, height: 5, channels: 3, background: { r: 0, g: 0, b: 0 } } } )
			.composite( [ {
				input: { create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 255, b: 255 } } },
				left: 2,
				top: 2,
			} ] )
			.png()
			.toBuffer();
		const result = await resizeBuffer( input, { filter: 'blurselective', webp: false } );
		const data = await sharp( result.data ).raw().toBuffer();
		// Centre: 255 * 8 / 16. Neighbour: 255 / 16.
		expect( Math.abs( data[( 2 * 5 + 2 ) * 3] - 128 ) ).toBeLessThanOrEqual( 1 );
		expect( Math.abs( data[( 2 * 5 + 3 ) * 3] - 16 ) ).toBeLessThanOrEqual( 1 );
	} );

	test( 'rejects an unknown filter', async () => {
		const { errors, pixel } = await run( await solid( 200, 100, 0 ), { filter: 'toString' } );
		expect( errors ).toContain( 'filter arg is not valid' );
		expect( pixel ).toEqual( [ 200, 100, 0 ] );
	} );
} );

describe( 'ulb', () => {
	/**
	 * A 100x60 white image inside a 140x100 black frame.
	 */
	async function letterboxed(): Promise<Buffer> {
		const inner = await sharp( { create: { width: 100, height: 60, channels: 3, background: '#ffffff' } } ).png().toBuffer();
		return sharp( { create: { width: 140, height: 100, channels: 3, background: '#000000' } } )
			.composite( [ { input: inner, left: 20, top: 20 } ] )
			.png()
			.toBuffer();
	}

	test( 'ulb=true removes the black frame', async () => {
		const { errors, width, height } = await run( await letterboxed(), { ulb: 'true' } );
		expect( errors ).toBe( '' );
		expect( width ).toBe( 100 );
		expect( height ).toBe( 60 );
	} );

	test( 'ulb then w scales the trimmed image', async () => {
		const { width, height } = await run( await letterboxed(), { ulb: 'true', w: '50' } );
		expect( width ).toBe( 50 );
		expect( height ).toBe( 30 );
	} );

	test( 'ulb does not trim an image without a frame', async () => {
		const { width, height } = await run( await solid( 200, 100, 0 ), { ulb: 'true' } );
		expect( width ).toBe( 8 );
		expect( height ).toBe( 8 );
	} );

	test( 'crop after ulb uses the trimmed image', async () => {
		// Left half of the 100x60 white area: no black from the frame.
		const { errors, width, height, pixel } = await run( await letterboxed(), { ulb: 'true', crop: '0,0,50,100' } );
		expect( errors ).toBe( '' );
		expect( width ).toBe( 50 );
		expect( height ).toBe( 60 );
		expect( pixel ).toEqual( [ 255, 255, 255 ] );
	} );

	test( 'a px crop larger than the trimmed image is clamped', async () => {
		const { errors, width, height } = await run( await letterboxed(), { ulb: 'true', crop: '50px,0px,120px,100px' } );
		expect( errors ).toBe( '' );
		expect( width ).toBe( 50 );
		expect( height ).toBe( 60 );
	} );

	test( 'ulb leaves a 2x2 image unchanged', async () => {
		const input = await sharp( { create: { width: 2, height: 2, channels: 3, background: '#000000' } } ).png().toBuffer();
		const { errors, width, height } = await run( input, { ulb: 'true' } );
		expect( errors ).toBe( '' );
		expect( width ).toBe( 2 );
		expect( height ).toBe( 2 );
	} );

	test( 'rejects a value other than true', async () => {
		const { errors, width } = await run( await letterboxed(), { ulb: '1' } );
		expect( errors ).toContain( 'ulb arg is not valid' );
		expect( width ).toBe( 140 );
	} );
} );

describe( 'filter combinations', () => {
	test( 'grayscale with brightness does not fail', async () => {
		const { errors, pixel } = await run( await solid( 200, 100, 0 ), { filter: 'grayscale', brightness: '20' } );
		expect( errors ).toBe( '' );
		// Luminance of 200,100,0 is 118.5, plus 20.
		pixel.forEach( value => expect( Math.abs( value - 139 ) ).toBeLessThanOrEqual( 1 ) );
	} );

	test( 'colorize runs before grayscale, so the result is grey', async () => {
		// 150,100,100 has luminance 0.299 * 150 + 0.587 * 100 + 0.114 * 100 = 115.
		const { pixel } = await run( await solid( 100, 100, 100 ), { filter: 'grayscale', colorize: '50,0,0' } );
		pixel.forEach( value => expect( Math.abs( value - 115 ) ).toBeLessThanOrEqual( 1 ) );
	} );

	test( 'negate after brightness clips first, as in GD', async () => {
		// 200 + 100 clips to 255, then negates to 0.
		const { pixel } = await run( await solid( 200, 200, 200 ), { brightness: '100', filter: 'negate' } );
		expect( pixel ).toEqual( [ 0, 0, 0 ] );
	} );

	test( 'smooth then a kernel filter matches running them one after another', async () => {
		// 9x9 black image with a white left column.
		const input = await sharp( { create: { width: 9, height: 9, channels: 3, background: { r: 0, g: 0, b: 0 } } } )
			.composite( [ {
				input: { create: { width: 1, height: 9, channels: 3, background: { r: 255, g: 255, b: 255 } } },
				left: 0,
				top: 0,
			} ] )
			.png()
			.toBuffer();
		const smoothed = await sharp( input ).convolve( { width: 3, height: 3, kernel: [ 1, 1, 1, 1, 0, 1, 1, 1, 1 ], scale: 8 } ).png().toBuffer();
		const expected = await sharp( smoothed ).removeAlpha().convolve( { width: 3, height: 3, kernel: [ -1, -1, -1, -1, 9, -1, -1, -1, -1 ], scale: 1 } ).raw().toBuffer();
		const result = await resizeBuffer( input, { smooth: '0', filter: 'meanremoval', webp: false } );
		const actual = await sharp( result.data ).removeAlpha().raw().toBuffer();
		expect( Array.from( actual ) ).toEqual( Array.from( expected ) );
		// The left edge stays white, as with two separate GD calls.
		expect( actual[0] ).toBe( 255 );
	} );

	test( 'smooth with a kernel filter applies both', async () => {
		// Black image with a white centre pixel.
		const input = await sharp( { create: { width: 9, height: 9, channels: 3, background: { r: 0, g: 0, b: 0 } } } )
			.composite( [ {
				input: { create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 255, b: 255 } } },
				left: 4,
				top: 4,
			} ] )
			.png()
			.toBuffer();
		const only = await resizeBuffer( input, { filter: 'meanremoval', webp: false } );
		const both = await resizeBuffer( input, { filter: 'meanremoval', smooth: '0', webp: false } );
		expect( both.info.errors ).toBe( '' );
		expect( both.data.equals( only.data ) ).toBe( false );
	} );

	test( 'edgedetect keeps a transparent pixel transparent', async () => {
		// Opaque white pixel in a transparent 5x5 image.
		const raw = Buffer.alloc( 5 * 5 * 4, 0 );
		raw.fill( 255, ( 2 * 5 + 2 ) * 4, ( 2 * 5 + 2 ) * 4 + 4 );
		const input = await sharp( raw, { raw: { width: 5, height: 5, channels: 4 } } ).png().toBuffer();
		const result = await resizeBuffer( input, { filter: 'edgedetect', webp: false } );
		const data = await sharp( result.data ).ensureAlpha().raw().toBuffer();
		expect( data[( 2 * 5 + 2 ) * 4 + 3] ).toBe( 255 );
		expect( data[( 2 * 5 + 3 ) * 4 + 3] ).toBe( 0 );
	} );

	test( 'ulb on an animated image is skipped, not an error', async () => {
		const gif = fs.readFileSync( __dirname + '/images/animated.gif' );
		const result = await resizeBuffer( gif, { ulb: 'true', w: '20', webp: false } );
		expect( result.info.errors ).toContain( 'ulb is not supported for animated images' );
		expect( result.info.format ).toBe( 'gif' );
		expect( result.info.width ).toBe( 20 );
	} );
} );
