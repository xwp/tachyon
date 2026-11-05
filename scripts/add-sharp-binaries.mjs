// Add sharp's Linux x64 and arm64 binaries to a built Lambda package, so one
// lambda.zip runs on both Lambda architectures. sharp loads the binary that
// matches the CPU at runtime.
//
// `sam build` installs only the binaries for the build container's CPU, and
// npm refuses to install packages for another CPU, so the missing ones are
// fetched with `npm pack` and unpacked into node_modules/@img.
//
// Usage: node scripts/add-sharp-binaries.mjs [package dir]
// Default package dir: .aws-sam/build/Tachyon

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageDir = resolve( process.argv[2] ?? '.aws-sam/build/Tachyon' );
const imgDir = join( packageDir, 'node_modules', '@img' );
const sharpPackage = join( packageDir, 'node_modules', 'sharp', 'package.json' );

if ( ! existsSync( sharpPackage ) ) {
	console.error( `sharp is not installed in ${ packageDir }. Run npm run build first.` );
	process.exit( 1 );
}

// Use the exact versions this sharp release depends on.
const { optionalDependencies } = JSON.parse( readFileSync( sharpPackage, 'utf8' ) );
const wanted = [
	'@img/sharp-linux-x64',
	'@img/sharp-libvips-linux-x64',
	'@img/sharp-linux-arm64',
	'@img/sharp-libvips-linux-arm64',
];

const work = mkdtempSync( join( tmpdir(), 'tachyon-sharp-' ) );
try {
	for ( const name of wanted ) {
		const version = optionalDependencies[name];
		if ( ! version ) {
			throw new Error( `sharp does not list ${ name } as a dependency.` );
		}
		const target = join( imgDir, name.replace( '@img/', '' ) );
		if ( existsSync( join( target, 'package.json' ) ) ) {
			console.log( `${ name }@${ version }: already installed` );
			continue;
		}
		const file = execFileSync( 'npm', [ 'pack', '--silent', `${ name }@${ version }` ], { cwd: work, encoding: 'utf8' } ).trim();
		mkdirSync( target, { recursive: true } );
		execFileSync( 'tar', [ '-xzf', join( work, file ), '-C', target, '--strip-components=1' ] );
		console.log( `${ name }@${ version }: added` );
	}
} finally {
	rmSync( work, { recursive: true, force: true } );
}
