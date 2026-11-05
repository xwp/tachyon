import fs from 'fs';

import { describe, test, expect } from '@jest/globals';

import { Args, isBooleanArg, parseBooleanArg, resizeBuffer } from '../src/lib';

const jpeg = fs.readFileSync( __dirname + '/images/hdr.jpg' ); // 899x446

/**
 * Resize the test JPEG with the given args.
 */
async function resize( args: Args ) {
	return resizeBuffer( jpeg, args );
}

describe( 'boolean args', () => {
	test.each( [ '0', '1', 'true', 'false', 'TRUE', true, false ] )( 'isBooleanArg(%p) is true', value => {
		expect( isBooleanArg( value ) ).toBe( true );
	} );

	test.each( [ 'garbage1', '10', 'yes', '' ] )( 'isBooleanArg(%p) is false', value => {
		expect( isBooleanArg( value ) ).toBe( false );
	} );

	test.each( [
		[ '1', true ],
		[ 'true', true ],
		[ '', true ],
		[ '0', false ],
		[ 'false', false ],
	] )( 'parseBooleanArg(%p) is %p', ( value, expected ) => {
		expect( parseBooleanArg( value ) ).toBe( expected );
	} );
} );

describe( 'webp and avif', () => {
	test( 'webp=0 keeps the source format', async () => {
		const { info } = await resize( { w: '100', webp: '0' } );
		expect( info.format ).toBe( 'jpeg' );
		expect( info.errors ).toBe( '' );
	} );

	test( 'webp=1 outputs webp', async () => {
		const { info } = await resize( { w: '100', webp: '1' } );
		expect( info.format ).toBe( 'webp' );
	} );

	test( 'invalid webp value is rejected', async () => {
		const { info } = await resize( { w: '100', webp: 'garbage1' } );
		expect( info.format ).toBe( 'jpeg' );
		expect( info.errors ).toContain( 'webp arg is not valid' );
	} );

	test( 'avif=false keeps the source format', async () => {
		const { info } = await resize( { w: '100', avif: 'false' } );
		expect( info.format ).toBe( 'jpeg' );
	} );
} );

describe( 'background', () => {
	test.each( [ '#fff', '#ff0000', 'red' ] )( 'accepts %p', async background => {
		const { info } = await resize( { lb: '300,300', background } );
		expect( info.errors ).toBe( '' );
		expect( info.width ).toBe( 300 );
		expect( info.height ).toBe( 300 );
	} );

	test( 'rejects an unknown colour', async () => {
		const { info } = await resize( { lb: '300,300', background: 'notacolor' } );
		expect( info.errors ).toContain( 'background arg is not valid' );
	} );
} );

describe( 'quality', () => {
	test.each( [ '10', '50', '100' ] )( 'accepts %p', async quality => {
		const { info } = await resize( { w: '100', quality } );
		expect( info.errors ).toBe( '' );
	} );

	test.each( [ '0', '9', '101', 'abc' ] )( 'rejects %p', async quality => {
		const { info } = await resize( { w: '100', quality } );
		expect( info.errors ).toContain( 'quality arg is not valid' );
	} );
} );

describe( 'zoom', () => {
	test( 'accepts zoom=2', async () => {
		const { info } = await resize( { w: '100', zoom: '2' } );
		expect( info.errors ).toBe( '' );
		expect( info.width ).toBe( 200 );
	} );

	test.each( [ '0.5', '11', '50' ] )( 'rejects %p', async zoom => {
		const { info } = await resize( { w: '100', zoom } );
		expect( info.errors ).toContain( 'zoom arg is not valid' );
		expect( info.width ).toBe( 100 );
	} );
} );

describe( 'crop flag', () => {
	test( 'crop=1 with w and h center-crops to the box', async () => {
		const { info } = await resize( { w: '200', h: '200', crop: '1' } );
		expect( info.errors ).toBe( '' );
		expect( info.width ).toBe( 200 );
		expect( info.height ).toBe( 200 );
	} );

	test( 'crop=0 with w and h fits inside the box', async () => {
		const { info } = await resize( { w: '200', h: '200', crop: '0' } );
		expect( info.errors ).toBe( '' );
		expect( info.width ).toBe( 200 );
		expect( info.height ).toBe( 99 );
	} );

	test.each( [ '1,2,3', '0.5px,0px,100px,100px' ] )( 'invalid crop %p is rejected', async crop => {
		const { info } = await resize( { w: '200', crop } );
		expect( info.errors ).toContain( 'crop arg is not valid' );
	} );

	test( 'fractional percentage crop is accepted', async () => {
		const { info } = await resize( { crop: '12.5,0,50,50' } );
		expect( info.errors ).toBe( '' );
	} );
} );
