var assign = require('lodash.assign');
var merge = require('lodash.merge');
var cloneDeep = require('lodash.clonedeep');
var when = require('when');
var fs = require('fs');
var jwt = require('jsonwebtoken');
var joi = require('joi');
var Boom = require('boom');

module.exports = function(port) {
    var httpMethods = {};
    var pendingRoutes = [];
    var validations = {};

    function addDebugInfo(msg, err) {
        err && port.config.debug || (port.config.debug == null && port.bus.config && port.bus.config.debug) && (msg.debug = err);
    }

    var rpcHandler = port.handler = function rpcHandler(request, _reply, customReply) {
        // custom validation. request.path === '/rpc' is because we already have validation for uri routed methods
        if (request.path === '/rpc' && validations[request.payload.method]) { // check for current method validation
            // try to validate all request validation
            var rqValRes = Object.keys(validations[request.payload.method].reqValidation).reduce((prev, key) => {
                if (!prev.error && validations[request.payload.method].reqValidation[key] && request[key]) {
                    return validations[request.payload.method].reqValidation[key].validate(request[key]);
                }
                return prev;
            }, {error: null});
            if (rqValRes.error) { // some of the request validation fails and returned an error
                var err = Boom.badRequest(rqValRes.error.message);
                err.output.payload.validation = {
                    source: 'payload',
                    keys: rqValRes.error.details.map((k) => {
                        return k.path;
                    })
                };
                return _reply(err);
            }
        }
        var startTime = process.hrtime();
        port.log.trace && port.log.trace({
            payload: request.payload
        });

        function addTime() {
            if (port.latency) {
                var diff = process.hrtime(startTime);
                port.latency(diff[0] * 1000 + diff[1] / 1000000, 1);
            }
        }

        var reply = function(resp, headers, statusCode) {
            addTime();
            var repl = _reply(resp);
            headers && Object.keys(headers).forEach(function(header) {
                repl.header(header, headers[header]);
            });
            if (statusCode) {
                repl.code(statusCode);
            }
            return repl;
        };

        function handleError(error, request, response) {
            var $meta = {};
            var msg = {
                jsonrpc: '2.0',
                id: (request.payload && request.payload.id) || '',
                error: error
            };
            addDebugInfo(msg, response);
            if (port.config.receive instanceof Function) {
                return when(port.config.receive(msg, $meta)).then(function(result) {
                    reply(result, $meta.responseHeaders, $meta.statusCode);
                });
            } else {
                return reply(msg);
            }
        }

        if (request.params.method && !request.payload.jsonrpc) {
            request.payload = {
                method: request.params.method,
                jsonrpc: '2.0',
                id: '1',
                params: cloneDeep(request.payload)
            };
        } else if (request.params.method && request.payload.jsonrpc) {
            if (
                (typeof request.params.method === 'string' && request.params.method !== request.payload.method) ||
                (Array.isArray(request.params.method) && request.params.method.indexOf(request.payload.method) < 0)
            ) {
                return handleError({
                    code: '-1',
                    message: 'Invalid request method, url method and jsonRpc method should be the same',
                    errorPrint: 'Invalid request method, url method and jsonRpc method should be the same'
                }, {});
            }
        }
        var endReply = {
            jsonrpc: '2.0',
            id: ''
        };
        if (!request.payload || !request.payload.method || !request.payload.id) {
            return handleError({
                code: '-1',
                message: (request.payload && !request.payload.id ? 'Missing request id' : 'Missing request method'),
                errorPrint: 'Invalid request!'
            }, {});
        }
        endReply.id = request.payload.id;

        var processMessage = function(msgOptions) {
            msgOptions = msgOptions || {};
            try {
                var $meta = {
                    auth: request.auth.credentials,
                    method: request.payload.method,
                    opcode: request.payload.method.split('.').pop(),
                    mtid: 'request',
                    requestHeaders: request.headers,
                    ipAddress: request.info && request.info.remoteAddress,
                    frontEnd: request.headers && request.headers['user-agent']
                };
                if (msgOptions.language) {
                    $meta.language = msgOptions.language;
                }
                // if(options.config && options.config.yar) {
                //    incMsg.$$.request = request;
                // }
                $meta.callback = function(response) {
                    if (!response) {
                        throw new Error('Add return value of method ' + request.payload.method);
                    }
                    if (!$meta || $meta.mtid === 'error') {
                        var erMs = $meta.errorMessage || response.message;
                        endReply.error = {
                            code: $meta.errorCode || response.code || -1,
                            message: erMs,
                            errorPrint: $meta.errorPrint || response.print || erMs,
                            type: $meta.errorType || response.type,
                            fieldErrors: $meta.fieldErrors || response.fieldErrors
                        };
                        if (typeof customReply === 'function') {
                            addDebugInfo(endReply, response);
                            return customReply(reply, endReply, $meta);
                        }
                        return handleError(endReply.error, request, response);
                    }
                    if (response.auth) {
                        delete response.auth;
                    }

                    // todo find a better way to return static file
                    if ($meta && $meta.staticFileName) {
                        addTime();
                        _reply.file($meta.staticFileName, $meta.staticFileOptions);
                        return true;
                    }

                    endReply.result = response;
                    if (msgOptions.end && typeof (msgOptions.end) === 'function') {
                        return msgOptions.end.call(void 0, reply(endReply, $meta.responseHeaders));
                    }
                    if (typeof customReply === 'function') {
                        customReply(reply, response, $meta);
                    } else {
                        reply(endReply, $meta.responseHeaders, $meta.statusCode);
                    }
                    return true;
                };
                port.stream.write([request.payload.params || {}, $meta]);
            } catch (err) {
                return handleError({
                    code: err.code || '-1',
                    message: err.message,
                    errorPrint: err.message,
                    type: err.type
                }, request, err);
            }
        };

        if (request.payload.method === 'identity.closeSession' && request.auth && request.auth.credentials) {
            return processMessage({
                end: (repl) => {
                    repl.state(port.config.jwt.cookieKey, '', port.config.cookie);
                }
            });
        }
        if (
            request.payload.method === 'identity.forgottenPasswordRequest' ||
            request.payload.method === 'identity.forgottenPasswordValidate' ||
            request.payload.method === 'identity.forgottenPassword' ||
            request.payload.method === 'identity.registerRequest' ||
            request.payload.method === 'identity.registerValidate'
        ) { // todo use standard processing once identity.check works for anonymous
            return processMessage();
        }
        port.bus.importMethod('identity.check')(
            request.payload.method === 'identity.check' ? assign({}, request.payload.params, request.auth.credentials)
                : assign({actionId: request.payload.method}, request.auth.credentials))
        .then((res) => {
            if (request.payload.method === 'identity.check') {
                endReply.result = res;
                if (res['identity.check'] && res['identity.check'].sessionId) {
                    return reply(endReply)
                        .state(
                            port.config.jwt.cookieKey,
                            jwt.sign({
                                timezone: (request.payload && request.payload.params && request.payload.params.timezone) || '+00:00',
                                actorId: res['identity.check'].actorId,
                                sessionId: res['identity.check'].sessionId
                            }, port.config.jwt.key),
                            port.config.cookie
                        );
                } else {
                    return reply(endReply);
                }
            } else if (request.payload.method === 'permission.get') {
                return processMessage();
            } else {
                if (res['permission.get'] && res['permission.get'].length) {
                    return processMessage({
                        language: res.language
                    });
                } else {
                    return handleError({
                        code: '-1',
                        message: `Missing Permission for ${request.payload.method}`,
                        errorPrint: `Missing Permission for ${request.payload.method}`
                    }, {});
                }
            }
        })
        .catch((err) => (
            handleError({
                code: err.code || '-1',
                message: err.message,
                errorPrint: err.errorPrint || err.message,
                type: err.type
            }, request, err)
        ));
    };

    pendingRoutes.unshift(merge({
        handler: rpcHandler
    }, port.config.routes.rpc));

    pendingRoutes.unshift(merge({
        handler: (req, repl) => {
            req.params.method = 'identity.check';
            return rpcHandler(req, repl);
        }
    }, port.config.routes.rpc, {
        path: '/login',
        config: {
            auth: false
        }
    }));

    pendingRoutes.unshift(merge({
        handler: (req, repl) => {
            req.params.method = [
                'identity.registerRequest',
                'identity.registerValidate'
            ];
            return rpcHandler(req, repl);
        }
    }, port.config.routes.rpc, {
        path: '/register',
        config: {
            auth: false
        }
    }));

    pendingRoutes.unshift(merge({
        handler: (req, repl) => {
            req.params.method = [
                'identity.forgottenPassword',
                'identity.forgottenPasswordRequest',
                'identity.forgottenPasswordValidate'
            ];
            return rpcHandler(req, repl);
        }
    }, port.config.routes.rpc, {
        path: '/forgottenPassword',
        config: {
            auth: false
        }
    }));

    port.bus.importMethods(httpMethods, port.config.api);
    Object.keys(httpMethods).forEach(function(key) { // create routes for all methods
        if (key.endsWith('.validations') && Array.isArray(httpMethods[key])) { // only documented methods will be added to the api
            httpMethods[key].forEach(function(validation) {
                if (!validation.schema.params) {
                    throw new Error('Missing \'params\' in validation schema for method: ' + validation.method);
                } else if (!validation.schema.params.isJoi) {
                    throw new Error('\'params\' must be a joi schema object! Method: ' + validation.method);
                } else if (!validation.schema.result) {
                    throw new Error('Missing \'result\' in validation schema for method: ' + validation.method);
                } else if (!validation.schema.result.isJoi) {
                    throw new Error('\'result\' must be a joi schema object! Method: ' + validation.method);
                }
                var reqValidation = {
                    payload: joi.object({
                        jsonrpc: joi.string().valid('2.0'),
                        id: joi.string(),
                        method: joi.string().valid(validation.method),
                        params: validation.schema.params.label('params')
                    })
                };
                var respValidation = {
                    schema: joi.object({
                        jsonrpc: joi.string().valid('2.0'),
                        id: joi.string(),
                        result: validation.schema.result.label('result'),
                        error: joi.object({
                            code: joi.number().integer().description('Error code'),
                            message: joi.string().description('Debug error message'),
                            errorPrint: joi.string().optional().description('User friendly error message'),
                            fieldErrors: joi.any().description('Field validation errors'),
                            type: joi.string().description('Error type')
                        }).label('error'),
                        debug: joi.object().label('debug').optional()
                    }).requiredKeys('jsonrpc', 'id').xor('result', 'error')
                };
                validations[validation.method] = {reqValidation, respValidation};
                pendingRoutes.unshift(merge({}, port.config.routes.rpc, {
                    method: 'POST',
                    path: '/rpc/' + validation.method.split('.').join('/'),
                    config: {
                        description: validation.schema.description || validation.method,
                        notes: (validation.schema.notes || []).concat([validation.method + ' method definition']),
                        tags: (validation.schema.tags || []).concat(['api', port.config.id, validation.method]),
                        validate: reqValidation,
                        response: respValidation
                    },
                    handler: function(req, repl) {
                        req.params.method = validation.method;
                        return rpcHandler(req, repl);
                    }
                }));
            });
        }
    });
    pendingRoutes.push({
        method: 'POST',
        path: '/file-upload',
        config: {
            payload: {
                maxBytes: 209715200, // default is 1048576 (1MB)
                output: 'stream',
                parse: true,
                allow: 'multipart/form-data'
            },
            handler: function(request, reply) {
                var file = request.payload.file;
                if (file) {
                    var fileName = (new Date()).getTime() + '_' + file.hapi.filename;
                    var path = port.bus.config.workDir + '/uploads/' + fileName;
                    var ws = fs.createWriteStream(path);
                    ws.on('error', function(err) {
                        port.log.error && port.log.error(err);
                        reply('');
                    });
                    file.pipe(ws);
                    file.on('end', function(err) {
                        if (err) {
                            port.log.error && port.log.error(err);
                            reply('');
                        } else {
                            reply(JSON.stringify({
                                filename: fileName,
                                headers: file.hapi.headers
                            }));
                        }
                    });
                } else {
                    // no file
                    reply('');
                }
            }
        }
    });
    return pendingRoutes;
};
