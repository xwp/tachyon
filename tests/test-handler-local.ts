import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import sharp from 'sharp';

import { getMaxAge, handler } from '../src/lambda-handler';
import { getCropRegion, resizeBuffer } from '../src/lib';

const jpeg = fs.readFileSync( __dirname + '/images/hdr.jpg' ); // 899x446

type Recorded = { method: string; url: string };

let s3Requests: Recorded[] = [];
let s3: http.Server;
let origin: http.Server;

/**
 * Start a server on a random port.
 */
function listen( server: http.Server ): Promise<number> {
	return new Promise( resolve => {
		server.listen( 0, '127.0.0.1', () => resolve( ( server.address() as AddressInfo ).port ) );
	} );
}

beforeAll( async () => {
	// S3 stub: every GET is a missing key, every PUT succeeds.
	s3 = http.createServer( ( req, res ) => {
		s3Requests.push( { method: req.method!, url: req.url! } );
		req.resume();
		req.on( 'end', () => {
			if ( req.method === 'GET' ) {
				res.statusCode = 404;
				res.setHeader( 'Content-Type', 'application/xml' );
				res.end( '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>x</Message></Error>' );
				return;
			}
			res.end();
		} );
	} );

	// Origin stub: path decides the response.
	origin = http.createServer( ( req, res ) => {
		if ( req.url!.includes( 'missing' ) ) {
			res.statusCode = 404;
			res.end();
		} else if ( req.url!.includes( 'broken' ) ) {
			res.statusCode = 500;
			res.end( 'origin error' );
		} else if ( req.url!.includes( 'html' ) ) {
			res.setHeader( 'Content-Type', 'text/html' );
			res.end( '<html>not an image</html>' );
		} else {
			res.setHeader( 'Content-Type', 'image/jpeg' );
			res.end( jpeg );
		}
	} );

	const [ s3Port, originPort ] = await Promise.all( [ listen( s3 ), listen( origin ) ] );
	process.env.S3_REGION = 'us-east-1';
	process.env.S3_BUCKET = 'bucket';
	process.env.S3_ENDPOINT = `http://127.0.0.1:${ s3Port }`;
	process.env.S3_FORCE_PATH_STYLE = '1';
	process.env.DOMAIN = `http://127.0.0.1:${ originPort }`;
	process.env.AWS_ACCESS_KEY_ID = 'test';
	process.env.AWS_SECRET_ACCESS_KEY = 'test';
} );

afterAll( () => {
	s3.close();
	origin.close();
} );

/**
 * Collects what the handler writes.
 */
class TestResponseStream {
	chunks: Buffer[] = [];
	metadata: any;
	setContentType(): void {}
	write( stream: string | Buffer ): void {
		this.chunks.push( Buffer.from( stream ) );
	}
	end(): void {}
	get body(): Buffer {
		return Buffer.concat( this.chunks );
	}
}

/**
 * Invoke the handler for a path and query.
 */
async function invoke( rawPath: string, queryStringParameters: Record<string, string> = {} ) {
	const stream = new TestResponseStream();
	await handler( { rawPath, queryStringParameters, headers: {} } as any, stream as any );
	return stream;
}

describe( 'handler', () => {
	test( 'serves a resized image from the origin and caches it in S3', async () => {
		s3Requests = [];
		const res = await invoke( '/uploads/photo.jpg', { w: '300' } );
		expect( res.metadata.statusCode ).toBe( 200 );
		expect( res.metadata.headers['Content-Type'] ).toBe( 'image/webp' );
		const meta = await sharp( res.body ).metadata();
		expect( meta.width ).toBe( 300 );
		expect( s3Requests.map( r => r.method ) ).toEqual( [ 'GET', 'PUT' ] );
	} );

	test( 'returns image/avif for avif output', async () => {
		const res = await invoke( '/uploads/photo.jpg', { w: '100', avif: '1' } );
		expect( res.metadata.statusCode ).toBe( 200 );
		expect( res.metadata.headers['Content-Type'] ).toBe( 'image/avif' );
	} );

	test( 'returns 404 when the origin has no file', async () => {
		const res = await invoke( '/uploads/missing.jpg' );
		expect( res.metadata.statusCode ).toBe( 404 );
	} );

	test( 'returns 502 when the origin fails', async () => {
		const res = await invoke( '/uploads/broken.jpg' );
		expect( res.metadata.statusCode ).toBe( 502 );
	} );

	test( 'does not cache a non-image origin response', async () => {
		s3Requests = [];
		const res = await invoke( '/uploads/html.jpg' );
		expect( res.metadata.statusCode ).toBe( 500 );
		expect( s3Requests.map( r => r.method ) ).toEqual( [ 'GET' ] );
	} );

	test( 'a presigned request does not fall back to the origin', async () => {
		s3Requests = [];
		const res = await invoke( '/uploads/photo.jpg', {
			'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
			'X-Amz-Credential': 'test/20261105/us-east-1/s3/aws4_request',
			'X-Amz-Date': '20261105T000000Z',
			'X-Amz-Expires': '300',
			'X-Amz-SignedHeaders': 'host',
			'X-Amz-Signature': 'abc',
		} );
		expect( res.metadata.statusCode ).toBe( 404 );
		expect( s3Requests.map( r => r.method ) ).toEqual( [ 'GET' ] );
	} );
} );

describe( 'getMaxAge', () => {
	const signedAt = Date.parse( '2026-11-05T00:00:00Z' );

	test( 'is a year without a presigned URL', () => {
		expect( getMaxAge( {} ) ).toBe( 31536000 );
	} );

	test( 'is the time until the presigned URL expires', () => {
		const args = { 'X-Amz-Date': '20261105T000000Z', 'X-Amz-Expires': '300' };
		expect( getMaxAge( args, signedAt + 100 * 1000 ) ).toBe( 200 );
	} );

	test( 'is 0 after the presigned URL expires', () => {
		const args = { 'X-Amz-Date': '20261105T000000Z', 'X-Amz-Expires': '300' };
		expect( getMaxAge( args, signedAt + 900 * 1000 ) ).toBe( 0 );
	} );
} );

describe( 'crop order', () => {
	test( 'crop is applied to the source before w', async () => {
		const { info } = await resizeBuffer( jpeg, { crop: '10,10,50,50', w: '200' } );
		expect( info.errors ).toBe( '' );
		expect( info.width ).toBe( 200 );
		// 50% x 50% of 899x446 is 450x223, scaled to 200 wide.
		expect( info.height ).toBe( 99 );
	} );

	test( 'px crop then resize', async () => {
		const { info } = await resizeBuffer( jpeg, { crop: '100px,50px,400px,400px', resize: '100,100' } );
		expect( info.width ).toBe( 100 );
		expect( info.height ).toBe( 100 );
	} );

	test( 'crop is clamped to the image', async () => {
		const { info } = await resizeBuffer( jpeg, { crop: '800px,0px,500px,500px' } );
		expect( info.width ).toBe( 99 );
		expect( info.height ).toBe( 446 );
	} );

	test( 'crop outside the image is ignored', async () => {
		const { info } = await resizeBuffer( jpeg, { crop: '950px,0px,10px,10px' } );
		expect( info.errors ).toContain( 'crop arg is outside the image' );
		expect( info.width ).toBe( 899 );
	} );

	test( 'a rejected crop does not turn off smart crop', async () => {
		const smart = await resizeBuffer( jpeg, { resize: '100,100', crop_strategy: 'smart' } );
		const withBadCrop = await resizeBuffer( jpeg, { resize: '100,100', crop_strategy: 'smart', crop: '950px,0px,10px,10px' } );
		expect( withBadCrop.info.errors ).toContain( 'crop arg is outside the image' );
		expect( withBadCrop.data.equals( smart.data ) ).toBe( true );
	} );

	test( 'getCropRegion uses oriented dimensions', () => {
		expect( getCropRegion( '0,0,50,50', 446, 899 ) ).toEqual( { left: 0, top: 0, width: 223, height: 450 } );
	} );

	test( 'crop uses coordinates after EXIF rotation', async () => {
		const rotated = await sharp( jpeg ).withMetadata( { orientation: 6 } ).toBuffer();
		const { info } = await resizeBuffer( rotated, { crop: '0,0,100,50' } );
		// Oriented size is 446x899, so the top half is 446x450.
		expect( info.width ).toBe( 446 );
		expect( info.height ).toBe( 450 );
	} );
} );
