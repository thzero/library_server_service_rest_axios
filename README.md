![GitHub package.json version](https://img.shields.io/github/package-json/v/thzero/library_server_service_rest_axios)
![David](https://img.shields.io/david/thzero/library_server_service_rest_axios)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# library_server_service_rest_axios

The outbound REST communication service for [@thzero/library_server](https://github.com/thzero/library_server), built on [axios](https://axios-http.com).

Implements `RestCommunicationService` so an application can call another backend without assembling headers, correlation ids or base urls by hand. Host resolution goes through the framework's service discovery when it is configured, and falls back to a configured base url when it is not.

## Requirements

### NodeJs

[NodeJs](https://nodejs.org) version 22+

### Installation

[![NPM](https://nodei.co/npm/@thzero/library_server_service_rest_axios.png?compact=true)](https://npmjs.org/package/@thzero/library_server_service_rest_axios)

```
npm install @thzero/library_server_service_rest_axios
```

This package declares `"exports": "./index.js"`, so import it by the bare package name — a deep import will not resolve.

```js
import communicationRestService from '@thzero/library_server_service_rest_axios';
```

#### Peer dependencies

* `@thzero/library_common`
* `@thzero/library_common_service`
* `@thzero/library_server`

## What it provides

`index.js` — default export `AxiosRestCommunicationService`, extending `RestCommunicationService`.

| Method | Signature |
|---|---|
| `get` / `delete` | `(correlationId, key, url, options)` |
| `getById` / `deleteById` | `(correlationId, key, url, id, options)` |
| `post` | `(correlationId, key, url, body, options)` |
| `postById` | `(correlationId, key, url, id, body, options)` |

`key` selects the backend from config. `options` is merged over the axios config, so anything axios accepts can be set per call.

Each call builds an axios instance that:

* sets `baseURL` from the resolved resource, with a trailing slash guaranteed;
* sends `Content-Type: application/json`;
* sends a correlationId header, **generating one when the caller has none** and writing it back onto `options.correlationId` so the caller can log the same value;
* sends an api key header when the resource or `options` supplies one, with `options.apiKey` winning;
* sends an `Authorization` bearer header when `options.token` is set, in the form the framework's own authentication middleware parses back;
* applies `options.timeout`, or the backend's configured `timeout`;
* treats any status from 200 to 503 as a resolved response rather than a throw, so failures arrive as responses.

`_validate` returns the payload on 200. On 401 it clears the user token through `SERVICE_AUTH`, when one is registered.

## Configuration

Per-backend, read through `_config.getBackend(correlationId, key)`:

```json
{
    "app": {
        "backend": {
            "<key>": {
                "baseUrl": "https://service-host/",
                "apiKey": "<api key>",
                "timeout": 30000,
                "discoverable": {
                    "name": "<discovery service name>",
                    "enabled": true
                }
            }
        }
    }
}
```

* **`baseUrl`** — used directly when discovery is off or unavailable.
* **`apiKey`** — sent as the api key header. `options.apiKey` overrides it per call.
* **`timeout`** — milliseconds. `options.timeout` overrides it per call.
* **`discoverable`** — omit it to skip discovery entirely. With it present, discovery is used only when a `SERVICE_DISCOVERY_RESOURCES` service is registered **and** `discoverable.enabled` is not `false`.
* **`discoverable.name`** — the name looked up in discovery. Required once discovery is active. Discovered resources are cached per key.

A discovered resource's url is assembled as `http(s)://<address>[:<port>]`, where the address is the resource's `address`, or a DNS name built from `label`, `namespace` and `local`.

## Wiring it up

Register it as the REST communication service from your `BootMain` derived class or a boot plugin:

```js
import communicationRestService from '@thzero/library_server_service_rest_axios';

this._injectService(LibraryServerConstants.InjectorKeys.SERVICE_COMMUNICATION_REST, new communicationRestService());
```

Then call it from a service:

```js
const response = await this._serviceCommunicationRest.get(correlationId, 'inventory', 'items', {
    token: request.token
});
```

The service resolves `SERVICE_AUTH` and `SERVICE_DISCOVERY_RESOURCES` during `init`; both may legitimately be absent.

## Development

```
npm run lint       # eslint .
npm run lint:fix   # eslint . --fix
npm test           # node --test "test/*.test.js"
```
