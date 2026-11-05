import fs from 'fs';

import { beforeAll, describe, expect, test } from '@jest/globals';
import sharp from 'sharp';

import { resizeBuffer } from '../src/lib';

let source: Buffer;

beforeAll( async () => {
	// hdr.jpg has EXIF and an ICC profile. Add XMP and a rotation so every
	// kind of metadata is present.
	source = await sharp( fs.readFileSync( __dirname + '/images/hdr.jpg' ) )
		.withMetadata( { orientation: 6 } )
		.withXmp( '<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>' )
		.toBuffer();
} );

/**
 * Resize the source and read back the output metadata.
 */
async function output( strip?: string ) {
	const result = await resizeBuffer( source, { w: '100', strip } );
	const meta = await sharp( result.data ).metadata();
	return {
		errors: result.info.errors,
		width: meta.width,
		height: meta.height,
		orientation: meta.orientation,
		exif: !! meta.exif,
		icc: !! meta.icc,
		xmp: !! meta.xmp,
	};
}

describe( 'strip', () => {
	test( 'strips all metadata by default', async () => {
		expect( await output() ).toMatchObject( { exif: false, icc: false, xmp: false } );
	} );

	test( 'strip=all strips all metadata', async () => {
		expect( await output( 'all' ) ).toMatchObject( { errors: '', exif: false, icc: false, xmp: false } );
	} );

	test( 'strip=none keeps all metadata', async () => {
		expect( await output( 'none' ) ).toMatchObject( { errors: '', exif: true, icc: true, xmp: true } );
	} );

	test( 'strip=info keeps only the ICC profile', async () => {
		expect( await output( 'info' ) ).toMatchObject( { errors: '', exif: false, icc: true, xmp: false } );
	} );

	test( 'strip=color keeps EXIF and XMP but not the ICC profile', async () => {
		expect( await output( 'color' ) ).toMatchObject( { errors: '', exif: true, icc: false, xmp: true } );
	} );

	test.each( [ undefined, 'all', 'none', 'info', 'color' ] )( 'strip=%p applies the rotation to the pixels', async strip => {
		const meta = await output( strip );
		// Rotated 90 degrees: 899x446 becomes 446x899, scaled to 100 wide.
		expect( meta.width ).toBe( 100 );
		expect( meta.height ).toBe( 201 );
		expect( [ undefined, 1 ] ).toContain( meta.orientation );
	} );

	test( 'rejects an invalid value and strips all', async () => {
		expect( await output( 'some' ) ).toMatchObject( {
			errors: 'strip arg is not valid',
			exif: false,
			icc: false,
		} );
	} );
} );
