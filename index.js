import axios from 'axios';

// import crc32 from 'crc/crc32'

import LibraryServerConstants from '@thzero/library_server/constants.js';

import LibraryCommonUtility from '@thzero/library_common/utility/index.js';
import LibraryMomentUtility from '@thzero/library_common/utility/moment.js';

import RestCommunicationService from '@thzero/library_server/service/restCommunication.js';

const contentType = 'Content-Type';
const contentTypeJson = 'application/json';
const separator = ': ';

// The keys on opts this service consumes itself. Anything else on opts is
// handed to axios as request config for that one call.
const optsOwn = new Set([ 'apiKey', 'correlationId', 'resource', 'timeout', 'token', 'url' ]);

class AxiosRestCommunicationService extends RestCommunicationService {
	constructor() {
		super();

		this._serviceAuth = null;
		this._serviceDiscoveryResources = null;

		// baseURL -> axios instance. One per backend, with its interceptor, rather
		// than one per call.
		this._instances = new Map();

		// key -> discovered resource. A failed discovery is remembered by time so a
		// backend that is down is asked about once per retry window rather than on
		// every call, and a discovery in flight is shared by the calls that arrive
		// while it runs.
		this._urls = new Map();
		this._urlsFailed = new Map();
		this._urlsPending = new Map();
		this._urlsRetryMs = 5 * 1000;
	}

	async init(injector) {
		await super.init(injector);

		this._serviceAuth = this._injector.getService(LibraryServerConstants.InjectorKeys.SERVICE_AUTH);
		this._serviceDiscoveryResources = this._injector.getService(LibraryServerConstants.InjectorKeys.SERVICE_DISCOVERY_RESOURCES);
	}

	async delete(correlationId, key, url, options) {
		const request = await this._create(correlationId, key, options);
		return this._validate(correlationId, await request.instance.delete(LibraryCommonUtility.formatUrl(url), request.config));
	}

	async deleteById(correlationId, key, url, id, options) {
		const request = await this._create(correlationId, key, options);
		return this._validate(correlationId, await request.instance.delete(LibraryCommonUtility.formatUrlParams(url, id), request.config));
	}

	async get(correlationId, key, url, options) {
		const request = await this._create(correlationId, key, options);
		return this._validate(correlationId, await request.instance.get(LibraryCommonUtility.formatUrl(url), request.config));
	}

	async getById(correlationId, key, url, id, options) {
		const request = await this._create(correlationId, key, options);
		return this._validate(correlationId, await request.instance.get(LibraryCommonUtility.formatUrlParams(url, id), request.config));
	}

	async post(correlationId, key, url, body, options) {
		const request = await this._create(correlationId, key, options);
		return this._validate(correlationId, await request.instance.post(LibraryCommonUtility.formatUrl(url), body, request.config));
	}

	async postById(correlationId, key, url, id, body, options) {
		const request = await this._create(correlationId, key, options);
		return this._validate(correlationId, await request.instance.post(LibraryCommonUtility.formatUrlParams(url, id), body, request.config));
	}

	// Resolves the backend and returns the shared axios instance for it, plus the
	// config for this one call: the headers that vary per call (correlation id,
	// api key, bearer token), the timeout, and whatever else on opts axios
	// understands. This used to build a new instance, spread the whole config and
	// register a new interceptor closure on every call.
	async _create(correlationId, key, opts) {
		let resource = null;

		let baseUrl = opts ? opts.url : null;
		let timeout = opts ? opts.timeout : null;

		if (String.isNullOrEmpty(baseUrl)) {
			const config = this._config.getBackend(correlationId, key);
			if (opts && opts.resource)
				resource = await this._determineResource(correlationId, opts.resource);
			else {
				resource = await this._determineResourceFromConfig(correlationId, config, key);
				timeout = config && config.timeout ? config.timeout : null;
			}
			this._enforceNotNull('AxiosRestCommunicationService', '_create', resource, 'resource', correlationId);
			this._enforceNotNull('AxiosRestCommunicationService', '_create', resource.url, 'resource.url', correlationId);
			baseUrl = resource.url;
		}

		if (!baseUrl.endsWith('/'))
			baseUrl += '/';

		const headers = {};

		let apiKey = null;
		if (resource && resource.authentication)
			apiKey = resource.authentication.apiKey;
		if (opts && opts.apiKey)
			apiKey = opts.apiKey;
		if (!String.isNullOrEmpty(apiKey))
			headers[LibraryServerConstants.Headers.AuthKeys.API] = apiKey;

		if (!correlationId)
			correlationId = opts.correlationId = LibraryCommonUtility.generateId();
		headers[LibraryServerConstants.Headers.CorrelationId] = correlationId;

		if (opts && opts.token)
			headers[LibraryServerConstants.Headers.AuthKeys.AUTH] = LibraryServerConstants.Headers.AuthKeys.AUTH_BEARER + separator + opts.token;
		headers[contentType] = contentTypeJson;

		const config = { headers: headers };
		if (timeout)
			config.timeout = timeout;
		if (opts) {
			for (const name of Object.keys(opts)) {
				if (!optsOwn.has(name))
					config[name] = opts[name];
			}
		}

		return { instance: this._instance(baseUrl), config: config };
	}

	async _determineResource(correlationId, resource) {
		this._enforceNotNull('AxiosRestCommunicationService', '_determineResource', resource, 'resource', correlationId);

		let port = resource.port ? resource.port : null;
		const secure = resource.secure ? resource.secure : false;

		let address = resource.address;
		if (resource.dns) {
			const temp = [];
			temp.push(resource.dns.label);
			if (!String.isNullOrEmpty(resource.dns.namespace))
				temp.push(resource.dns.namespace);
			if (resource.dns.local)
				temp.push('local');
			address = temp.join('.');
		}

		if (!resource.authentication)
			resource.authentication = {};

		resource.url = `http${secure ? 's' : ''}://${address}${port ? `:${port}` : ''}`;

		return resource;
	}

	async _determineResourceFromConfig(correlationId, config, key) {
		this._enforceNotNull('AxiosRestCommunicationService', '_determineResourceFromConfig', config, 'config', correlationId);
		this._enforceNotNull('AxiosRestCommunicationService', '_determineResourceFromConfig', key, 'key', correlationId);

		const resource = {
			url: config.baseUrl,
			authentication: {
				apiKey: config.apiKey
			}
		};

		this._logger.debug('AxiosRestCommunicationService', '_determineResourceFromConfig', 'config.discoverable', config.discoverable, correlationId);
		if (!config.discoverable)
			return resource;

		this._logger.debug('AxiosRestCommunicationService', '_determineResourceFromConfig', '_serviceDiscoveryResources', LibraryCommonUtility.isNotNull(this._serviceDiscoveryResources), correlationId);
		if (!this._serviceDiscoveryResources)
			return resource;

		this._logger.debug('AxiosRestCommunicationService', '_determineResourceFromConfig', 'config.discoverable.enabled', config.discoverable.enabled, correlationId);
		const enabled = config.discoverable.enabled === false ? false : true;
		this._logger.debug('AxiosRestCommunicationService', '_determineResourceFromConfig', 'enabled', enabled, correlationId);
		if (!enabled)
			return resource;

		const discovered = this._urls.get(key);
		if (discovered)
			return discovered;

		// A failure used to cache nothing, so every call after it took the mutex
		// and asked discovery again, one at a time.
		const failed = this._urlsFailed.get(key);
		if (failed && ((LibraryMomentUtility.getTimestamp() - failed) < this._urlsRetryMs))
			return null;

		// One discovery per key at a time. Calls for the same key share it; calls
		// for other keys are not held up by it, which the single mutex did.
		let pending = this._urlsPending.get(key);
		if (!pending) {
			pending = this._discover(correlationId, config, key)
				.finally(() => {
					this._urlsPending.delete(key);
				});
			this._urlsPending.set(key, pending);
		}
		return await pending;
	}

	async _discover(correlationId, config, key) {
		this._enforceNotNull('AxiosRestCommunicationService', '_determineResourceFromConfig', config.discoverable.name, 'discoveryName', correlationId);

		const response = await this._serviceDiscoveryResources.getService(correlationId, config.discoverable.name);
		if (this._hasFailed(response)) {
			this._urlsFailed.set(key, LibraryMomentUtility.getTimestamp());
			return null;
		}

		const resource = await this._determineResource(correlationId, response.results);

		if (config.apiKey)
			resource.authentication.apiKey = config.apiKey;

		this._urls.set(key, resource);
		this._urlsFailed.delete(key);
		return resource;
	}

	_instance(baseUrl) {
		let instance = this._instances.get(baseUrl);
		if (instance)
			return instance;

		instance = axios.create({
			baseURL: baseUrl,
			validateStatus: function (status) {
				return status >= 200 && status <= 503
			}
		});

		// const unreliablePromise = (resolveOn, onReject) => () => {
		// 	if (--resolveOn > 0) {
		// 		onReject()
		// 		return Promise.reject()
		// 	}
		// 	return Promise.resolve()
		// }

		//	 const retry = (retries, fn) => fn().catch(err => retries > 1 ? retry(retries - 1, fn) : Promise.reject(err))
		//	 const pause = (duration) => new Promise(res => setTimeout(res, duration))
		//	 const backoff = (retries, fn, delay = 500) =>
		// 	fn().catch(err => retries > 1
		//		? pause(delay).then(() => backoff(retries - 1, fn, delay * 2))
		//		: Promise.reject(err))

		// Registered once per instance. The error handler used to be a plain
		// function, so `this` inside it was undefined and its 401 branch threw a
		// TypeError in place of what it meant to do. validateStatus accepts 401,
		// so this handler only sees transport failures and 5xx above 503; the 401
		// handling that actually runs is the one in _validate. This branch now
		// does the same as that one, then rejects as an error should.
		instance.interceptors.response.use(
			(response) => response,
			(error) => {
				if (error && error.response && error.response.status === 401)
					this._tokenUserClear();
				return Promise.reject(error);
			});

		this._instances.set(baseUrl, instance);
		return instance;
	}

	_tokenUserClear() {
		if (this._serviceAuth && this._serviceAuth.tokenUser)
			this._serviceAuth.tokenUser(null, true);
	}

	_validate(correlationId, response) {
		if (response.status === 200) {
			// TODO: CRC
			// if (response.data.results && response.data.results.data) {
			// 	const dataCheck = crc32(JSON.stringify(response.data.results)).toString(16)
			// 	if (!response.data.check != dataCheck)
			// 		return this._error('AxiosRestCommunicationService', '_validate', 'Invalid CRC check')
			// }
			return response.data;
		}

		if (response.status === 401) {
			this._tokenUserClear();
			return this._error('AxiosRestCommunicationService', '_validate', 'Invalid authorization', null, null, null, correlationId);
		}

		if (response.status === 404)
			return this._error('AxiosRestCommunicationService', '_validate', 'Resource not found', null, null, null, correlationId);

		return this._error('AxiosRestCommunicationService', '_validate', 'Not valid response', null, null, null, correlationId);
	}
}

export default AxiosRestCommunicationService;
