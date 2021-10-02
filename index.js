import axios from 'axios';
import { Mutex as asyncMutex } from 'async-mutex';

// import crc32 from 'crc/crc32'

import LibraryConstants from '@thzero/library_server/constants';

import Utility from '@thzero/library_common/utility';

import RestCommunicationService from '@thzero/library_server/service/restCommunication';

const contentType = 'Content-Type';
const contentTypeJson = 'application/json';

class AxiosRestCommunicationService extends RestCommunicationService {
	constructor() {
		super();

		this._mutex = new asyncMutex();

		this._serviceAuth = null;
		this._serviceDiscoveryResources = null;

		this._urls = new Map();
	}

	async init(injector) {
		await super.init(injector);

		this._serviceAuth = this._injector.getService(LibraryConstants.InjectorKeys.SERVICE_AUTH);
		this._serviceDiscoveryResources = this._injector.getService(LibraryConstants.InjectorKeys.SERVICE_DISCOVERY_RESOURCES);
	}

	async delete(correlationId, key, url, options) {
		const executor = await this._create(correlationId, key, options);
		return this._validate(correlationId, await executor.delete(Utility.formatUrl(url)));
	}

	async deleteById(correlationId, key, url, id, options) {
		const executor = await this._create(correlationId, key, options);
		return this._validate(correlationId, await executor.delete(Utility.formatUrlParams(url, id)));
	}

	async get(correlationId, key, url, options) {
		const executor = await this._create(correlationId, key, options);
		return this._validate(correlationId, await executor.get(Utility.formatUrl(url)));
	}

	async getById(correlationId, key, url, id, options) {
		const executor = await this._create(correlationId, key, options);
		return this._validate(correlationId, await executor.get(Utility.formatUrlParams(url, id)));
	}

	async post(correlationId, key, url, body, options) {
		const executor = await this._create(correlationId, key, options);
		return this._validate(correlationId, await executor.post(Utility.formatUrl(url), body));
	}

	async postById(correlationId, key, url, id, body, options) {
		const executor = await this._create(correlationId, key, options);
		return this._validate(correlationId, await executor.post(Utility.formatUrlParams(url, id), body));
	}

	async _create(correlationId, key, opts) {
		let resource = null;

		let baseUrl = opts ? opts.url : null;
		let timeout = opts ? opts.timeout : null;

		if (String.isNullOrEmpty(baseUrl)) {
			const config = this._config.getBackend(key);
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
			headers[LibraryConstants.Headers.AuthKeys.API] = apiKey;

		if (!correlationId)
			correlationId = opts.correlationId = Utility.generateId();
		headers[LibraryConstants.Headers.CorrelationId] = correlationId;

		if (opts && opts.token)
			headers[LibraryConstants.Headers.AuthKeys.AUTH] = LibraryConstants.Headers.AuthKeys.AUTH_BEARER + separator + opts.token;
		headers[contentType] = contentTypeJson;

		let options = {
			baseURL: baseUrl,
			headers: headers,
			validateStatus: function (status) {
				return status >= 200 && status <= 503
			}
		};

		if (timeout)
			options.timeout = dtimeout;
		options = { ...options, ...opts };

		const instance = axios.create(options);

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

		// Add a response interceptor
		instance.interceptors.response.use(function (response) {
			// Any status code that lie within the range of 2xx cause this function to trigger
			return response
		},
		function (error) {
			// Any status codes that falls outside the range of 2xx cause this function to trigger// Any status codes that falls outside the range of 2xx cause this function to trigger
			// await retry(3, unreliablePromise(3, log('Error'))).then(log('Resolved'))

			if (error && error.response && error.response.status === 401) {
				return this._serviceAuth.tokenUser(null, true).resolve()
			}

			return Promise.reject(error)
		});

		return instance;
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

		resource.authentication = resource.authentication;
		if (!resource.authentication)
			resource.authentication = {};

		resource.url = `http${secure ? 's' : ''}://${address}${port ? `:${port}` : ''}`;

		return resource;
	}

	async _determineResourceFromConfig(correlationId, config, key) {
		this._enforceNotNull('AxiosRestCommunicationService', '_determineResourceFromConfig', config, 'config', correlationId);
		this._enforceNotNull('AxiosRestCommunicationService', '_determineResourceFromConfig', key, 'key', correlationId);

		let resource = {
			url: config.baseUrl,
			authentication: {
				apiKey: config.apiKey
			}
		};
		
		this._logger.debug('AxiosRestCommunicationService', '_determineResourceFromConfig', 'config.discoverable', config.discoverable, correlationId);
		if (!config.discoverable)
			return resource;

		this._logger.debug('AxiosRestCommunicationService', '_determineResourceFromConfig', '_serviceDiscoveryResources', (this._serviceDiscoveryResources != null), correlationId);
		if (!this._serviceDiscoveryResources)
			return resource;

		this._logger.debug('AxiosRestCommunicationService', '_determineResourceFromConfig', 'config.discoverable.enabled', config.discoverable.enabled, correlationId);
		const enabled = config.discoverable.enabled === false ? false : true;
		this._logger.debug('AxiosRestCommunicationService', '_determineResourceFromConfig', 'enabled', enabled, correlationId);
		if (!enabled)
			return resource;

		resource = this._urls.get(key);
		if (resource)
			return resource;

		const release = await this._mutex.acquire();
		try {
			resource = this._urls.get(key);
			if (resource)
				return resource;

			this._enforceNotNull('AxiosRestCommunicationService', '_determineResourceFromConfig', config.discoverable.name, 'discoveryName', correlationId);

			const response = await this._serviceDiscoveryResources.getService(correlationId, config.discoverable.name);
			if (!response.success)
				return null;

			if (config.apiKey)
				resource.authentication.apiKey = config.apiKey;

			this._determineResource(config, response.results);

			this._urls.set(key, resource);
		}
		finally {
			release();
		}

		return resource;
	}

	_validate(correlationId, response) {
		if (response.status === 200) {
			// TODO: CRC
			// if (response.data.results && response.data.results.data) {
			// 	const dataCheck = crc32(JSON.stringify(response.data.results)).toString(16)
			// 	if (!response.data.check != dataCheck)
			// 		return this._error('AxiosRestCommunicationService', '_validate', 'Invalid CRC check')
			// }
			return this._success(response.data, correlationId);
		}

		if (response.status === 401) {
			if (this._serviceAuth) {
				if (this._serviceAuth.tokenUser)
					this._serviceAuth.tokenUser(null, true);
			}

			return this._error('AxiosRestCommunicationService', '_validate', 'Invalid authorization', null, null, null, correlationId);
		}

		if (response.status === 404)
			return this._error('AxiosRestCommunicationService', '_validate', 'Resource not found', null, null, null, correlationId);

		return this._error('AxiosRestCommunicationService', '_validate', 'Not valid response', null, null, null, correlationId);
	}
}

export default AxiosRestCommunicationService;
