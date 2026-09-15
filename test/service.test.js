import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import '@thzero/library_common/utility/string.js';
import LibraryServerConstants from '@thzero/library_server/constants.js';
import AxiosRestCommunicationService from '../index.js';

const AUTH = LibraryServerConstants.Headers.AuthKeys.AUTH;
const API = LibraryServerConstants.Headers.AuthKeys.API;
const CORRELATION_ID = LibraryServerConstants.Headers.CorrelationId;

// The base class has carried _config and _logger as prototype getters and as
// plain fields at different versions; defineProperty works against either shape.
const inject = (target, name, value) => {
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
	return target;
};

const newLogger = () => ({ debug() {}, info() {}, warn() {}, error() {}, exception() {}, fatal() {}, trace() {} });

let service;

beforeEach(() => {
	service = new AxiosRestCommunicationService();
	inject(service, '_logger', newLogger());
	inject(service, '_config', { getBackend: () => ({ baseUrl: 'http://backend/' }) });
});

describe('_create', () => {
	// Regression: the bearer header was built as AUTH_BEARER + separator + token
	// with no `separator` declared anywhere in the module, so every call carrying a
	// token threw ReferenceError: separator is not defined.
	it('builds an Authorization header for a token', async () => {
		const instance = await service._create('cid', 'key', { url: 'http://x/', token: 'abc' });
		const header = instance.defaults.headers[AUTH];
		assert.ok(header, 'the Authorization header is set');
		assert.ok(header.endsWith('abc'), `token must be present, got ${header}`);
		assert.ok(header.startsWith(LibraryServerConstants.Headers.AuthKeys.AUTH_BEARER),
			`must carry the bearer prefix, got ${header}`);
	});

	// The prefix and separator have to match what the fastify authentication
	// middleware accepts on the far end.
	it('uses a form the server side parses back to the token', async () => {
		const instance = await service._create('cid', 'key', { url: 'http://x/', token: 'abc' });
		const header = instance.defaults.headers[AUTH];
		const prefix = LibraryServerConstants.Headers.AuthKeys.AUTH_BEARER;
		const rest = header.slice(prefix.length);
		assert.ok(rest === ': abc' || rest === ' abc', `unexpected separator in ${JSON.stringify(header)}`);
	});

	it('sets no Authorization header without a token', async () => {
		const instance = await service._create('cid', 'key', { url: 'http://x/' });
		assert.equal(instance.defaults.headers[AUTH], undefined);
	});

	// Regression: `options.timeout = dtimeout` - an identifier that exists nowhere -
	// so supplying a timeout threw ReferenceError instead of setting one.
	it('applies a supplied timeout', async () => {
		const instance = await service._create('cid', 'key', { url: 'http://x/', timeout: 1234 });
		assert.equal(instance.defaults.timeout, 1234);
	});

	it('takes the timeout from config when opts carries none', async () => {
		inject(service, '_config', { getBackend: () => ({ baseUrl: 'http://backend/', timeout: 4321 }) });
		const instance = await service._create('cid', 'key', {});
		assert.equal(instance.defaults.timeout, 4321);
	});

	it('always sends a correlationId, generating one if needed', async () => {
		const given = await service._create('cid-123', 'key', { url: 'http://x/' });
		assert.equal(given.defaults.headers[CORRELATION_ID], 'cid-123');

		const opts = { url: 'http://x/' };
		const generated = await service._create(null, 'key', opts);
		assert.ok(generated.defaults.headers[CORRELATION_ID], 'one was generated');
		assert.equal(generated.defaults.headers[CORRELATION_ID], opts.correlationId,
			'and written back onto opts so the caller can log it');
	});

	it('sends the api key from opts, which wins over the resource', async () => {
		const instance = await service._create('cid', 'key', {
			resource: { address: 'host', authentication: { apiKey: 'from-resource' } },
			apiKey: 'from-opts'
		});
		assert.equal(instance.defaults.headers[API], 'from-opts');
	});

	it('ensures the base url ends with a slash', async () => {
		const instance = await service._create('cid', 'key', { url: 'http://x' });
		assert.equal(instance.defaults.baseURL, 'http://x/');
	});
});

describe('_determineResource', () => {
	it('builds a plain http url from an address and port', async () => {
		const resource = await service._determineResource('cid', { address: 'host', port: 8080 });
		assert.equal(resource.url, 'http://host:8080');
	});

	it('uses https when the resource is secure, and omits a missing port', async () => {
		const resource = await service._determineResource('cid', { address: 'host', secure: true });
		assert.equal(resource.url, 'https://host');
	});

	it('assembles a dns name from label, namespace and local', async () => {
		const resource = await service._determineResource('cid',
			{ dns: { label: 'svc', namespace: 'ns', local: true }, port: 80 });
		assert.equal(resource.url, 'http://svc.ns.local:80');
	});

	// The address assignment sits outside the `local` test despite its indentation,
	// so a non-local dns resource still gets a joined address rather than undefined.
	it('assembles a dns name that is not local', async () => {
		const resource = await service._determineResource('cid', { dns: { label: 'svc', namespace: 'ns' } });
		assert.equal(resource.url, 'http://svc.ns');
	});

	it('gives the resource an authentication object when it has none', async () => {
		const resource = await service._determineResource('cid', { address: 'host' });
		assert.deepEqual(resource.authentication, {});
	});

	it('leaves an existing authentication object alone', async () => {
		const resource = await service._determineResource('cid', { address: 'host', authentication: { apiKey: 'k' } });
		assert.deepEqual(resource.authentication, { apiKey: 'k' });
	});

	it('rejects a null resource', async () => {
		await assert.rejects(() => service._determineResource('cid', null), /resource is null/);
	});
});

describe('_determineResourceFromConfig', () => {
	it('returns the configured base url when discovery is off', async () => {
		const resource = await service._determineResourceFromConfig('cid', { baseUrl: 'http://x/', apiKey: 'k' }, 'key');
		assert.equal(resource.url, 'http://x/');
		assert.equal(resource.authentication.apiKey, 'k');
	});

	it('returns the configured base url when no discovery service is wired up', async () => {
		const resource = await service._determineResourceFromConfig('cid',
			{ baseUrl: 'http://x/', discoverable: { name: 'svc' } }, 'key');
		assert.equal(resource.url, 'http://x/');
	});

	it('returns the configured base url when discovery is explicitly disabled', async () => {
		service._serviceDiscoveryResources = { getService: async () => { throw new Error('must not be called'); } };
		const resource = await service._determineResourceFromConfig('cid',
			{ baseUrl: 'http://x/', discoverable: { name: 'svc', enabled: false } }, 'key');
		assert.equal(resource.url, 'http://x/');
	});

	// Regression: `resource = this._urls.get(key)` overwrote the resource that had
	// just been built with undefined on a cache miss. The apiKey assignment below
	// it then threw, _determineResource was called with (config, results) against a
	// (correlationId, resource) signature and its return value dropped, and
	// undefined was what got cached.
	it('resolves a discovered resource', async () => {
		service._serviceDiscoveryResources = {
			getService: async () => ({ success: true, results: { address: 'discovered', port: 9000 } })
		};
		const resource = await service._determineResourceFromConfig('cid',
			{ baseUrl: 'http://x/', apiKey: 'k', discoverable: { name: 'svc' } }, 'key');
		assert.equal(resource.url, 'http://discovered:9000');
		assert.equal(resource.authentication.apiKey, 'k');
	});

	it('caches the discovered resource', async () => {
		let lookups = 0;
		service._serviceDiscoveryResources = {
			getService: async () => { lookups++; return { success: true, results: { address: 'discovered' } }; }
		};
		const config = { baseUrl: 'http://x/', discoverable: { name: 'svc' } };
		const first = await service._determineResourceFromConfig('cid', config, 'key');
		const second = await service._determineResourceFromConfig('cid', config, 'key');
		assert.equal(lookups, 1, 'the second call came from the cache');
		assert.equal(second, first, 'and it is the same resource, not undefined');
	});

	it('returns null when discovery fails', async () => {
		service._serviceDiscoveryResources = { getService: async () => ({ success: false }) };
		const resource = await service._determineResourceFromConfig('cid',
			{ baseUrl: 'http://x/', discoverable: { name: 'svc' } }, 'key');
		assert.equal(resource, null);
	});

	it('rejects a null config or key', async () => {
		await assert.rejects(() => service._determineResourceFromConfig('cid', null, 'key'), /config is null/);
		await assert.rejects(() => service._determineResourceFromConfig('cid', { baseUrl: 'x' }, null), /key is null/);
	});
});

describe('_validate', () => {
	it('returns the payload on 200', () => {
		assert.deepEqual(service._validate('cid', { status: 200, data: { success: true } }), { success: true });
	});

	it('clears the user token on 401', () => {
		let cleared = false;
		service._serviceAuth = { tokenUser: () => { cleared = true; } };
		service._validate('cid', { status: 401, data: {} });
		assert.equal(cleared, true);
	});
});
