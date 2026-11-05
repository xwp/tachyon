import fs from 'fs';

import { describe, expect, test } from '@jest/globals';
import sharp from 'sharp';

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
 * Process an image as PNG (lossless) and return the centre pixel.
 */
async function pixel( input: Buffer, args: Args ) {
	const result = await resizeBuffer( input, { ...args, webp: false } );
	const { data, info } = await sharp( result.data ).raw().toBuffer( { resolveWithObject: true } );
	const i = ( 4 * info.width + 4 ) * info.channels;
	return { errors: result.info.errors, rgba: Array.from( data.subarray( i, i + info.channels ) ) };
}

describe( 'brightness', () => {
	test( 'brightness=40 adds 40 to each channel', async () => {
		const { errors, rgba } = await pixel( await solid( 100, 100, 100 ), { brightness: '40' } );
		expect( errors ).toBe( '' );
		expect( rgba ).toEqual( [ 140, 140, 140 ] );
	} );

	test( 'brightness=-255 is black', async () => {
		const { rgba } = await pixel( await solid( 200, 120, 40 ), { brightness: '-255' } );
		expect( rgba ).toEqual( [ 0, 0, 0 ] );
	} );

	test.each( [ '256', '-256', '1.5', 'abc' ] )( 'rejects %p', async brightness => {
		const { errors, rgba } = await pixel( await solid( 100, 100, 100 ), { brightness } );
		expect( errors ).toContain( 'brightness arg is not valid' );
		expect( rgba ).toEqual( [ 100, 100, 100 ] );
	} );
} );

describe( 'contrast', () => {
	test( 'contrast=50 moves values away from mid-grey', async () => {
		const { rgba } = await pixel( await solid( 200, 60, 128 ), { contrast: '50' } );
		expect( rgba[0] ).toBeGreaterThan( 200 );
		expect( rgba[1] ).toBeLessThan( 60 );
	} );

	test( 'contrast=-100 is flat mid-grey', async () => {
		const { rgba } = await pixel( await solid( 200, 60, 10 ), { contrast: '-100' } );
		rgba.forEach( value => expect( Math.abs( value - 128 ) ).toBeLessThanOrEqual( 1 ) );
	} );

	test.each( [ '101', '-101' ] )( 'rejects %p', async contrast => {
		const { errors } = await pixel( await solid( 100, 100, 100 ), { contrast } );
		expect( errors ).toContain( 'contrast arg is not valid' );
	} );
} );

describe( 'clipping between adjustments', () => {
	test( 'brightness=255 then contrast=100 on black is white, as in GD', async () => {
		const { errors, rgba } = await pixel( await solid( 0, 0, 0 ), { brightness: '255', contrast: '100' } );
		expect( errors ).toBe( '' );
		expect( rgba ).toEqual( [ 255, 255, 255 ] );
	} );

	test( 'colorize after a saturating brightness starts from 255', async () => {
		const { rgba } = await pixel( await solid( 200, 200, 200 ), { brightness: '100', colorize: '-50,0,0' } );
		expect( rgba ).toEqual( [ 205, 255, 255 ] );
	} );
} );

describe( 'colorize', () => {
	test( 'colorize=100,0,0 adds red', async () => {
		const { errors, rgba } = await pixel( await solid( 50, 50, 50 ), { colorize: '100,0,0' } );
		expect( errors ).toBe( '' );
		expect( rgba ).toEqual( [ 150, 50, 50 ] );
	} );

	test( 'colorize keeps alpha', async () => {
		const { rgba } = await pixel( await solid( 50, 50, 50, 0.5 ), { colorize: '0,0,100' } );
		expect( rgba.slice( 0, 3 ) ).toEqual( [ 50, 50, 150 ] );
		expect( Math.abs( rgba[3] - 128 ) ).toBeLessThanOrEqual( 1 );
	} );

	test( 'colorize, brightness and contrast combine', async () => {
		const { rgba } = await pixel( await solid( 100, 100, 100 ), { colorize: '20,0,0', brightness: '10' } );
		expect( rgba ).toEqual( [ 130, 110, 110 ] );
	} );

	test( 'colorize tints a greyscale image', async () => {
		const grey = await sharp( await solid( 50, 50, 50 ) ).greyscale().toColourspace( 'b-w' ).png().toBuffer();
		expect( ( await sharp( grey ).metadata() ).channels ).toBe( 1 );
		const { rgba } = await pixel( grey, { colorize: '100,0,0' } );
		expect( rgba ).toEqual( [ 150, 50, 50 ] );
	} );

	test( 'colorize tints a greyscale image with alpha', async () => {
		const grey = await sharp( await solid( 50, 50, 50, 0.5 ) ).greyscale().toColourspace( 'b-w' ).png().toBuffer();
		expect( ( await sharp( grey ).metadata() ).channels ).toBe( 2 );
		const { rgba } = await pixel( grey, { colorize: '0,100,0' } );
		expect( rgba.slice( 0, 3 ) ).toEqual( [ 50, 150, 50 ] );
		expect( Math.abs( rgba[3] - 128 ) ).toBeLessThanOrEqual( 1 );
	} );

	test.each( [ '1,2', '1,2,3,4', '300,0,0', 'red' ] )( 'rejects %p', async colorize => {
		const { errors } = await pixel( await solid( 100, 100, 100 ), { colorize } );
		expect( errors ).toContain( 'colorize arg is not valid' );
	} );
} );

describe( '16-bit input', () => {
	/**
	 * A solid 8x8 16-bit PNG, `grey` gives one band instead of RGB.
	 */
	function solid16( value: number, grey = false ): Promise<Buffer> {
		const channels = grey ? 1 : 3;
		const raw = new Uint16Array( 8 * 8 * channels ).fill( value * 257 );
		// A Uint16Array input is read as 16-bit.
		return sharp( raw, { raw: { width: 8, height: 8, channels } } )
			.toColourspace( grey ? 'grey16' : 'rgb16' )
			.png()
			.toBuffer();
	}

	test( 'brightness works on a 16-bit image', async () => {
		const input = await solid16( 100 );
		expect( ( await sharp( input ).metadata() ).depth ).toBe( 'ushort' );
		const { rgba } = await pixel( input, { brightness: '40' } );
		expect( rgba ).toEqual( [ 140, 140, 140 ] );
	} );

	test( 'contrast=-100 is mid-grey on a 16-bit image', async () => {
		const { rgba } = await pixel( await solid16( 200 ), { contrast: '-100' } );
		rgba.forEach( value => expect( Math.abs( value - 128 ) ).toBeLessThanOrEqual( 1 ) );
	} );

	test( 'colorize tints a 16-bit greyscale image', async () => {
		const { rgba } = await pixel( await solid16( 100, true ), { colorize: '100,0,0' } );
		expect( rgba ).toEqual( [ 200, 100, 100 ] );
	} );
} );

describe( 'CMYK input', () => {
	/**
	 * A solid 8x8 CMYK JPEG, and the sRGB pixel sharp gives with no args.
	 */
	async function cmyk() {
		const input = await sharp( { create: { width: 8, height: 8, channels: 3, background: { r: 180, g: 80, b: 20 } } } )
			.toColourspace( 'cmyk' )
			.jpeg()
			.toBuffer();
		const { rgba: plain } = await pixel( input, {} );
		return { input, plain };
	}

	test( 'brightness=0 with smooth keeps the colours', async () => {
		const { input, plain } = await cmyk();
		const { rgba } = await pixel( input, { smooth: '10000' } );
		rgba.forEach( ( value, i ) => expect( Math.abs( value - plain[i] ) ).toBeLessThanOrEqual( 1 ) );
	} );

	test( 'brightness adds to the converted colours', async () => {
		const { input, plain } = await cmyk();
		const { rgba } = await pixel( input, { brightness: '20' } );
		rgba.forEach( ( value, i ) => expect( Math.abs( value - Math.min( plain[i] + 20, 255 ) ) ).toBeLessThanOrEqual( 1 ) );
	} );
} );

describe( 'smooth', () => {
	test( 'smooth blends a pixel with its neighbours', async () => {
		// Black image with one white pixel in the centre.
		const input = await sharp( {
			create: { width: 9, height: 9, channels: 3, background: { r: 0, g: 0, b: 0 } },
		} )
			.composite( [ {
				input: { create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 255, b: 255 } } },
				left: 4,
				top: 4,
			} ] )
			.png()
			.toBuffer();
		const result = await resizeBuffer( input, { smooth: '1', webp: false } );
		const { data } = await sharp( result.data ).raw().toBuffer( { resolveWithObject: true } );
		// Weight 1, scale 9: centre is 255/9 and its neighbour is 255/9.
		const centre = data[( 4 * 9 + 4 ) * 3];
		const neighbour = data[( 4 * 9 + 5 ) * 3];
		expect( Math.abs( centre - 28 ) ).toBeLessThanOrEqual( 1 );
		expect( Math.abs( neighbour - 28 ) ).toBeLessThanOrEqual( 1 );
	} );

	test( 'smooth keeps alpha', async () => {
		// Opaque white pixel in a transparent 5x5 image.
		const raw = Buffer.alloc( 5 * 5 * 4, 0 );
		raw.fill( 255, ( 2 * 5 + 2 ) * 4, ( 2 * 5 + 2 ) * 4 + 4 );
		const input = await sharp( raw, { raw: { width: 5, height: 5, channels: 4 } } ).png().toBuffer();
		const result = await resizeBuffer( input, { smooth: '1', webp: false } );
		const { data } = await sharp( result.data ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
		expect( data[( 2 * 5 + 2 ) * 4 + 3] ).toBe( 255 );
		expect( data[( 2 * 5 + 3 ) * 4 + 3] ).toBe( 0 );
	} );

	test( 'smooth does not mix animation frames', async () => {
		// Two 4x4 frames: black, then white.
		const frames = Buffer.concat( [ Buffer.alloc( 4 * 4 * 3, 0 ), Buffer.alloc( 4 * 4 * 3, 255 ) ] );
		const input = await sharp( frames, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } } )
			.webp( { lossless: true, loop: 0, delay: [ 100, 200 ] } )
			.toBuffer();
		const result = await resizeBuffer( input, { smooth: '1', webp: true, quality: '100' } );
		const meta = await sharp( result.data, { animated: true } ).metadata();
		expect( meta.pages ).toBe( 2 );
		expect( meta.delay ).toEqual( [ 100, 200 ] );
		const data = await sharp( result.data, { animated: true } ).raw().toBuffer();
		const channels = data.length / ( 4 * 8 );
		// Last row of frame 1 and first row of frame 2.
		expect( data[3 * 4 * channels] ).toBeLessThanOrEqual( 2 );
		expect( data[4 * 4 * channels] ).toBeGreaterThanOrEqual( 253 );
	} );

	test.each( [
		[ 'svg', Buffer.from( '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>' ), 'png' ],
		[ 'avif', null, 'heif' ],
		[ 'tiff', null, 'tiff' ],
	] )( 'smooth with webp=0 keeps a %s source in a format sharp can write', async ( name, svg, expected ) => {
		const input = svg ?? await sharp( { create: { width: 8, height: 8, channels: 3, background: 'red' } } ).toFormat( name as 'avif' | 'tiff' ).toBuffer();
		const result = await resizeBuffer( input, { smooth: '1', webp: false } );
		expect( result.info.format ).toBe( expected );
	} );

	test( 'smooth keeps a gif a gif', async () => {
		const gif = fs.readFileSync( __dirname + '/images/animated.gif' );
		const result = await resizeBuffer( gif, { smooth: '1', w: '20', webp: false } );
		expect( result.info.format ).toBe( 'gif' );
		expect( ( await sharp( result.data, { animated: true } ).metadata() ).pages ).toBe( 48 );
	} );

	test.each( [ '-1', '10001', '9'.repeat( 400 ) ] )( 'rejects %p', async smooth => {
		const { errors, rgba } = await pixel( await solid( 100, 100, 100 ), { smooth } );
		expect( errors ).toContain( 'smooth arg is not valid' );
		expect( rgba ).toEqual( [ 100, 100, 100 ] );
	} );
} );
