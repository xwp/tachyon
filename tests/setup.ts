/**
 * Jest setup file. Mocks the AWS Lambda runtime global `awslambda` before any
 * test module is imported, because lambda-handler.ts calls
 * awslambda.streamifyResponse() at module scope.
 *
 * Based on upstream humanmade/tachyon 270a8e9.
 */
global.awslambda = {
	/**
	 * Return the handler unchanged, as there is no streaming runtime in tests.
	 */
	streamifyResponse( handler: StreamifyHandler ): StreamifyHandler {
		return handler;
	},
	HttpResponseStream: {
		/**
		 * Attach the response metadata to the stream so tests can read it.
		 */
		from( stream: ResponseStream, metadata ): ResponseStream {
			stream.metadata = metadata;
			return stream;
		},
	},
};
