import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import '@thzero/library_common/utility/string.js';
import LibraryMomentUtility from '@thzero/library_common/utility/moment.js';
import LibraryServerConstants from '@thzero/library_server/constants.js';
import AxiosRestCommunicationService from '../index.js';

// dayjs.utc() only exists once the plugins are registered; the app does this at
// boot, so anything calling getTimestamp() outside a booted app must do it too.
LibraryMomentUtility.initDateTime();

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

// _create returns the shared axios instance for the backend plus the request
// config for the one call. The per-call values live on the config; the instance
// carries only the base url and the interceptor.
describe('_create', () => {
	// Regression: the bearer header was built as AUTH_BEARER + separator + token
	// with no `separator` declared anywhere in the module, so every call carrying a
	// token threw ReferenceError: separator is not defined.
	it('builds an Authorization header for a token', async () => {
		const { config } = await service._create('cid', 'key', { url: 'http://x/', token: 'abc' });
		const header = config.headers[AUTH];
		assert.ok(header, 'the Authorization header is set');
		assert.ok(header.endsWith('abc'), `token must be present, got ${header}`);
		assert.ok(header.startsWith(LibraryServerConstants.Headers.AuthKeys.AUTH_BEARER),
			`must carry the bearer prefix, got ${header}`);
	});

	// The prefix and separator have to match what the fastify authentication
	// middleware accepts on the far end.
	it('uses a form the server side parses back to the token', async () => {
		const { config } = await service._create('cid', 'key', { url: 'http://x/', token: 'abc' });
		const header = config.headers[AUTH];
		const prefix = LibraryServerConstants.Headers.AuthKeys.AUTH_BEARER;
		const rest = header.slice(prefix.length);
		assert.ok(rest === ': abc' || rest === ' abc', `unexpected separator in ${JSON.stringify(header)}`);
	});

	it('sets no Authorization header without a token', async () => {
		const { config } = await service._create('cid', 'key', { url: 'http://x/' });
		assert.equal(config.headers[AUTH], undefined);
	});

	// Regression: `options.timeout = dtimeout` - an identifier that exists nowhere -
	// so supplying a timeout threw ReferenceError instead of setting one.
	it('applies a supplied timeout', async () => {
		const { config } = await service._create('cid', 'key', { url: 'http://x/', timeout: 1234 });
		assert.equal(config.timeout, 1234);
	});

	it('takes the timeout from config when opts carries none', async () => {
		inject(service, '_config', { getBackend: () => ({ baseUrl: 'http://backend/', timeout: 4321 }) });
		const { config } = await service._create('cid', 'key', {});
		assert.equal(config.timeout, 4321);
	});

	it('always sends a correlationId, generating one if needed', async () => {
		const given = await service._create('cid-123', 'key', { url: 'http://x/' });
		assert.equal(given.config.headers[CORRELATION_ID], 'cid-123');

		const opts = { url: 'http://x/' };
		const generated = await service._create(null, 'key', opts);
		assert.ok(generated.config.headers[CORRELATION_ID], 'one was generated');
		assert.equal(generated.config.headers[CORRELATION_ID], opts.correlationId,
			'and written back onto opts so the caller can log it');
	});

	it('sends the api key from opts, which wins over the resource', async () => {
		const { config } = await service._create('cid', 'key', {
			resource: { address: 'host', authentication: { apiKey: 'from-resource' } },
			apiKey: 'from-opts'
		});
		assert.equal(config.headers[API], 'from-opts');
	});

	it('ensures the base url ends with a slash', async () => {
		const { instance } = await service._create('cid', 'key', { url: 'http://x' });
		assert.equal(instance.defaults.baseURL, 'http://x/');
	});

	it('passes anything else on opts to axios as request config', async () => {
		const { config } = await service._create('cid', 'key', { url: 'http://x/', responseType: 'stream', token: 't' });
		assert.equal(config.responseType, 'stream');
		assert.equal(config.token, undefined, 'the keys this service consumes do not leak through');
		assert.equal(config.url, undefined);
	});
});

// Regression: every call built a new axios instance, spread the config and
// registered a new interceptor closure.
describe('the shared instance', () => {
	it('is one per base url, reused across calls', async () => {
		const a = await service._create('cid', 'key', { url: 'http://x/', token: 'one' });
		const b = await service._create('cid', 'key', { url: 'http://x', token: 'two' });
		const c = await service._create('cid', 'key', { url: 'http://y/' });
		assert.equal(b.instance, a.instance);
		assert.notEqual(c.instance, a.instance);
		assert.equal(service._instances.size, 2);
	});

	it('carries none of the per-call headers, so calls cannot see each other\'s tokens', async () => {
		const a = await service._create('cid-a', 'key', { url: 'http://x/', token: 'one' });
		const b = await service._create('cid-b', 'key', { url: 'http://x/', token: 'two' });
		assert.equal(a.instance.defaults.headers[AUTH], undefined);
		assert.equal(a.instance.defaults.headers[CORRELATION_ID], undefined);
		assert.ok(a.config.headers[AUTH].endsWith('one'));
		assert.ok(b.config.headers[AUTH].endsWith('two'));
	});

	it('registers the interceptor once', async () => {
		const { instance } = await service._create('cid', 'key', { url: 'http://x/' });
		await service._create('cid', 'key', { url: 'http://x/' });
		await service._create('cid', 'key', { url: 'http://x/' });
		assert.equal(instance.interceptors.response.handlers.length, 1);
	});

	// Regression: the error handler was a plain function, so `this` inside it was
	// undefined and the 401 branch threw a TypeError.
	it('the error interceptor clears the user token on a 401 and rejects', async () => {
		let cleared = false;
		service._serviceAuth = { tokenUser: () => { cleared = true; } };
		const { instance } = await service._create('cid', 'key', { url: 'http://x/' });
		const handler = instance.interceptors.response.handlers[0];
		const error = { response: { status: 401 } };
		await assert.rejects(() => handler.rejected(error), (err) => err === error);
		assert.equal(cleared, true);
	});

	it('the error interceptor passes any other failure through', async () => {
		const { instance } = await service._create('cid', 'key', { url: 'http://x/' });
		const handler = instance.interceptors.response.handlers[0];
		const error = new Error('ECONNREFUSED');
		await assert.rejects(() => handler.rejected(error), (err) => err === error);
	});

	it('the request path hands the call config to the instance', async () => {
		const calls = [];
		service._instance = () => ({
			async get(url, config) { calls.push({ url, config }); return { status: 200, data: { ok: true } }; }
		});
		const result = await service.get('cid', 'key', 'things', { url: 'http://x/', token: 't', timeout: 5 });
		assert.deepEqual(result, { ok: true });
		assert.equal(calls[0].url, 'things');
		assert.ok(calls[0].config.headers[AUTH].endsWith('t'));
		assert.equal(calls[0].config.timeout, 5);
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

	// Regression: a failure cached nothing, so every call after it took the mutex
	// and asked discovery again, one at a time.
	it('does not ask discovery again for a failed key within the retry window', async () => {
		let lookups = 0;
		service._serviceDiscoveryResources = { getService: async () => { lookups++; return { success: false }; } };
		const config = { baseUrl: 'http://x/', discoverable: { name: 'svc' } };
		assert.equal(await service._determineResourceFromConfig('cid', config, 'key'), null);
		assert.equal(await service._determineResourceFromConfig('cid', config, 'key'), null);
		assert.equal(await service._determineResourceFromConfig('cid', config, 'key'), null);
		assert.equal(lookups, 1);
	});

	it('asks again once the retry window has passed, and forgets the failure on success', async () => {
		let lookups = 0;
		let succeed = false;
		service._serviceDiscoveryResources = {
			getService: async () => { lookups++; return succeed ? { success: true, results: { address: 'up' } } : { success: false }; }
		};
		service._urlsRetryMs = 0;
		const config = { baseUrl: 'http://x/', discoverable: { name: 'svc' } };
		assert.equal(await service._determineResourceFromConfig('cid', config, 'key'), null);
		succeed = true;
		const resource = await service._determineResourceFromConfig('cid', config, 'key');
		assert.equal(resource.url, 'http://up');
		assert.equal(lookups, 2);
		assert.equal(service._urlsFailed.has('key'), false);
	});

	it('shares one discovery between concurrent calls for the same key', async () => {
		let lookups = 0;
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		service._serviceDiscoveryResources = {
			getService: async () => { lookups++; await gate; return { success: true, results: { address: 'discovered' } }; }
		};
		const config = { baseUrl: 'http://x/', discoverable: { name: 'svc' } };
		const pending = Promise.all([
			service._determineResourceFromConfig('a', config, 'key'),
			service._determineResourceFromConfig('b', config, 'key')
		]);
		release();
		const [ first, second ] = await pending;
		assert.equal(lookups, 1);
		assert.equal(second, first);
		assert.equal(service._urlsPending.size, 0);
	});

	// The single mutex serialized every key behind whichever was in flight.
	it('does not hold one key\'s discovery behind another\'s', async () => {
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		service._serviceDiscoveryResources = {
			getService: async (correlationId, name) => {
				if (name === 'slow')
					await gate;
				return { success: true, results: { address: name } };
			}
		};
		const slow = service._determineResourceFromConfig('cid', { baseUrl: 'http://x/', discoverable: { name: 'slow' } }, 'slow');
		const fast = await service._determineResourceFromConfig('cid', { baseUrl: 'http://x/', discoverable: { name: 'fast' } }, 'fast');
		assert.equal(fast.url, 'http://fast', 'resolved while the slow one is still in flight');
		release();
		assert.equal((await slow).url, 'http://slow');
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
