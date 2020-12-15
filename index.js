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

		this._baseUrls = new Map();
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
		const config = this._config.getBackend(key);
		// let baseUrl = config.baseUrl;
		let baseUrl = await this._determineUrl(correlationId, config, key);
		this._enforceNotNull('AxiosRestCommunicationService', '_create', baseUrl, 'baseUrl', correlationId);
		if (!baseUrl.endsWith('/'))
			baseUrl += '/';

		const headers = {};
		headers[LibraryConstants.Headers.AuthKeys.API] = config.apiKey;
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

		if (config.timeout)
			options.timeout = config.timeout;
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

	async _determineUrl(correlationId, config, key) {
		this._enforceNotNull('AxiosRestCommunicationService', '_determineUrl', config, 'config', correlationId);
		this._enforceNotNull('AxiosRestCommunicationService', '_determineUrl', key, 'key', correlationId);

		let baseUrl = config.baseUrl;
		if (this._serviceDiscoveryResources && config.discoverable) {
			baseUrl = this._baseUrls.get(name);
			if (baseUrl)
				return baseUrl;

			const release = await this._mutex.acquire();
			try {
				baseUrl = this._baseUrls.get(name);
				if (baseUrl)
					return baseUrl;

				this._enforceNotNull('AxiosRestCommunicationService', '_determineUrl', config.discoveryName, 'discoveryName', correlationId);

				const response = await this._serviceDiscoveryResources.getService(correlationId, config.discoveryName);
				if (!response.success)
					return null;

				this._enforceNotNull('AxiosRestCommunicationService', '_determineUrl', response.results, 'results', correlationId);
				this._enforceNotNull('AxiosRestCommunicationService', '_determineUrl', response.results.address, 'results.address', correlationId);
				this._enforceNotNull('AxiosRestCommunicationService', '_determineUrl', response.results.port, 'results.address', correlationId);

				if (response.results.dns) {
					const temp = [];
					temp.push(response.results.dns.label);
					if (!String.isNullOrEmpty(response.results.dns.namespace))
						temp.push(response.results.dns.namespace);
					if (response.results.dns.local)
						temp.push('local');
					response.results.address = temp.join('.');
				}

				baseUrl = `http${response.results.secure ? 's' : ''}://${response.results.address}${response.results.port ? `:${response.results.port}` : ''}`;
				baseUrl = !String.isNullOrEmpty(config.discoveryRoot) ? baseUrl + config.discoveryRoot : baseUrl;
				this._baseUrls.set(key, baseUrl);
			}
			finally {
				release();
			}
		}

		return baseUrl;
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
