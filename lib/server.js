var jayson = require('./');
var events = require('events');
var utils = require('./utils');

/**
 *  Constructor for a Jayson server
 *  @class Jayson JSON-RPC Server
 *  @extends require('events').EventEmitter
 *  @param {Object} [methods] Methods to add
 *  @param {Object} [options] Options to set
 *  @property {Object} options A reference to the internal options object that can be modified directly
 *  @property {Object} errorMessages Hash of (error code) => (error message) pairs that will be used in this server instances' responses
 *  @property {HttpServer} http HTTP interface constructor
 *  @property {HttpsServer} https HTTPS interface constructor
 *  @property {Function} middleware Middleware generator function
 *  @return {Server}
 *  @api public
 */
var Server = function(methods, options) {
  if(!(this instanceof Server)) return new Server(methods, options);

  var defaults = {
    reviver: null,
    replacer: null,
    encoding: 'utf8'
  };

  this.options = utils.merge(defaults, options || {});
  
  this._methods = {};

  // adds methods passed to constructor
  this.methods(methods || {});

  // assigns interfaces to this instance
  var interfaces = Server.interfaces;
  for(var name in interfaces) {
    this[name] = interfaces[name].bind(interfaces[name], this);
  }

  // copies error messages for defined codes into this instance
  this.errorMessages = {};
  for(var handle in Server.errors) {
    var code = Server.errors[handle];
    this.errorMessages[code] = Server.errorMessages[code];
  }

};
utils.inherits(Server, events.EventEmitter);

module.exports = Server;

/**
 * Interfaces that will be automatically bound as properties of a Server instance
 * @type Object
 * @static
 */
Server.interfaces = {
  http: require('./server/http'),
  https: require('./server/https'),
  middleware: require('./server/middleware')
};

/**
 * Fork server constructor
 * @type ForkServer
 * @static
 */
Server.fork = require('./server/fork');

/**
 * JSON-RPC specification errors that map to a integer code
 * @type Object
 * @static
 */
Server.errors = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
};

/*
 * Error codes that map to an error message
 * @static
 */
Server.errorMessages = {};
Server.errorMessages[Server.errors.PARSE_ERROR] = 'Parse Error';
Server.errorMessages[Server.errors.INVALID_REQUEST] = 'Invalid request';
Server.errorMessages[Server.errors.METHOD_NOT_FOUND] = 'Method not found';
Server.errorMessages[Server.errors.INVALID_PARAMS] = 'Invalid method parameter(s)';
Server.errorMessages[Server.errors.INTERNAL_ERROR] = 'Internal error';

/**
 *  Adds a single method to the server
 *  @param {String} name Name of method to add
 *  @param {Function|Client} definition Function or Client for a relayed method
 *  @throws {TypeError} Invalid parameters
 *  @return {void}
 *  @api public
 */
Server.prototype.method = function(name, definition) {
  // a valid method is either a function or a client (relayed method)
  if(typeof(definition) !== 'function' && !(definition instanceof jayson.Client)) throw new TypeError(definition + ' must be either a function or an instance of Client');
  if(!name || typeof(name) !== 'string') throw new TypeError(name + ' must be a non-zero length string');
  if(/^rpc\./.test(name)) throw new TypeError(name + ' has a reserved name');
  this._methods[name] = definition;
};

/**
 *  Adds a batch of methods to the server
 *  @param {Object} methods Methods to add
 *  @return {void}
 *  @api public
 */
Server.prototype.methods = function(methods) {
  methods = methods || {};
  for(var name in methods) this.method(name, methods[name]);
};

/**
 *  Checks if a method is registered with the server
 *  @param {String} name Name of method
 *  @return {Boolean}
 *  @api public
 */
Server.prototype.hasMethod = function(name) {
  return name in this._methods;
};

/**
 *  Removes a method from the server
 *  @param {String} name
 *  @return {void}
 *  @api public
 */
Server.prototype.removeMethod = function(name) {
  if(this.hasMethod(name)) {
    delete this._methods[name];
  }
};

/**
 *  Returns a JSON-RPC compatible error property
 *  @param {Number} [code=-32603] Error code
 *  @param {String} [message="Internal error"] Error message
 *  @param {Object} [data] Additional data that should be provided
 *  @return {Object}
 *  @api public
 */
Server.prototype.error = function(code, message, data) {
  if(typeof(code) !== 'number') {
    code = Server.errors.INTERNAL_ERROR;
  }

  if(typeof(message) !== 'string') {
    message = this.errorMessages[code] || '';
  }

  var error = { code: code, message: message };
  if(typeof(data) !== 'undefined') error.data = data;
  return error;
};

/**
 *  Calls a method on the server
 *  @param {Object|Array|String} request A JSON-RPC request object. Object for single request, Array for batches and String for automatic parsing (using the reviver option)
 *  @param {Function} [callback] Callback that receives one of two arguments: first is an error and the second a response 
 *  @return {void}
 *  @api public
 */
Server.prototype.call = function(request, originalCallback) {
  var self = this;

  if(typeof(originalCallback) !== 'function') originalCallback = function() {};

  // compose the callback so that we may emit an event on every response
  var callback = function(error, response) {
    var emit = self.emit.bind(self, 'response');
    self.emit('response', request, response || error);
    originalCallback.apply(null, arguments);
  };

  // if passed a string, assume that it should be parsed
  if(typeof(request) === 'string') {
    try {
      request = JSON.parse(request, this.options.reviver);
    } catch(exception) {
      var error = this.error(Server.errors.PARSE_ERROR, null, exception);
      return callback(utils.response(error));
    }
  }

  // is this a batch request?
  if(Array.isArray(request)) {
    // special case if empty batch request
    if(!request.length) {
      return callback(utils.response(this.error(Server.errors.INVALID_REQUEST)));
    }
    return this._batch(request, callback);
  }

  this.emit('request', request);

  // is the request valid?
  if(!isValidRequest(request)) {
    return callback(utils.response(this.error(Server.errors.INVALID_REQUEST)));
  }

  // from now on we are "notification"-aware and can deliberately ignore errors for such requests
  var respond = function(error, result) {
    if(isNotification(request)) return callback();
    var response = utils.response(error, result, request.id);
    if(response.error) callback(response);
    else callback(null, response);
  };
  
  // does the method exist?
  if(!this.hasMethod(request.method)) {
    return respond(this.error(Server.errors.METHOD_NOT_FOUND));
  }

  var args = [];
  var method = this._methods[request.method];

  // are we attempting to invoke a relayed method?
  if(method instanceof jayson.Client) {
    return method.request(request.method, request.params, callback);
  }

  // deal with named parameters in request
  if(request.params && !Array.isArray(request.params)) {
    var parameters = utils.getParameterNames(method);

    // pop the last one out because it must be the callback
    parameters.pop();

    // TODO deal with strictness (missing params etc)
    args = parameters.map(function(name) {
      return request.params[name];
    });
  }

  // adds request params to arguments for the method
  if(Array.isArray(request.params)) {
    args = args.concat(request.params);
  }

  // the callback that server methods receive
  args.push(function(error, result) {
    if(isValidError(error)) return respond(error);

    // got an invalid error
    if(error) return respond(self.error(Server.errors.INTERNAL_ERROR));

    respond(null, result);
  });

  // calls the requested method with the server as this
  method.apply(this, args);
};

/**
 *  Evaluates a batch request
 *  @return {void}
 *  @api private
 */
Server.prototype._batch = function(requests, callback) {
  var self = this;
  
  var responses = [];

  this.emit('batch', requests);

  /**
   * @ignore
   */
  var maybeRespond = function() {
    var done = responses.every(function(res) { return res  !== null; });
    if(done) {
      // filters away notifications
      var filtered = responses.filter(function(res) { return res !== true; });
      // only notifications in request means empty response
      if(!filtered.length) return callback();
      callback(null, filtered);
    }
  }

  /**
   * @ignore
   */
  var wrapper = function(request, index) {
    responses[index] = null;
    return function() {
      if(!isValidRequest(request)) {
        responses[index] = utils.response(self.error(Server.errors.INVALID_REQUEST));
        maybeRespond();
      } else {
        self.call(request, function(error, response) {
          responses[index] = error || response || true;
          maybeRespond();
        });
      }
    }
  };

  var stack = requests.map(function(request, index) {
    // ignore possibly nested requests
    if(Array.isArray(request)) return null;
    return wrapper(request, index);
  });

  stack.forEach(function(method) {
    if(typeof(method) === 'function') method();
  });
};

/**
 * Is the passed argument a valid JSON-RPC request?
 * @ignore
 */
function isValidRequest(request) {
  return Boolean(
    request
    && typeof(request) === 'object'
    && request.jsonrpc === '2.0'
    && typeof(request.method) === 'string'
    && (
      typeof(request.params) === 'undefined'
      || Array.isArray(request.params)
      || (request.params && typeof(request.params) === 'object')
    )
    && (
      typeof(request.id) === 'undefined'
      || typeof(request.id) === 'string'
      || typeof(request.id) === 'number'
      || request.id === null
    )
  );
}

/**
 * Is the passed argument a JSON-RPC notfication?
 * @ignore
 */
function isNotification(request) {
  return Boolean(
    request
    && (
      typeof(request.id) === 'undefined'
      || request.id === null
    )
  );
}

/**
 * Is the passed argument a valid JSON-RPC error?
 * @ignore
 */
function isValidError(error) {
  return Boolean(
    error
    && typeof(error.code) === 'number'
    && parseInt(error.code) == error.code
    && typeof(error.message) === 'string'
  );
}
