'use strict';

const EventEmitter = require('events').EventEmitter;
const exec = require('child_process').exec;
const qs = require('qs');
const crypto = require('crypto');

const hasOwn = {}.hasOwnProperty;
const isPlainObject = require('lodash.isplainobject');

const OPTIONS_KEYS = [
  'api_key',
  'idempotency_key',
  'stripe_account',
  'stripe_version',
];

const utils = (module.exports = {
  isOptionsHash: (o) => {
    return isPlainObject(o) && OPTIONS_KEYS.some((key) => hasOwn.call(o, key));
  },

  /**
   * Stringifies an Object, accommodating nested objects
   * (forming the conventional key 'parent[child]=value')
   */
  stringifyRequestData: (data) => {
    return (
      qs
        .stringify(data, {
          serializeDate: (d) => Math.floor(d.getTime() / 1000),
        })
        // Don't use strict form encoding by changing the square bracket control
        // characters back to their literals. This is fine by the server, and
        // makes these parameter strings easier to read.
        .replace(/%5B/g, '[')
        .replace(/%5D/g, ']')
    );
  },

  /**
   * Outputs a new function with interpolated object property values.
   * Use like so:
   *   var fn = makeURLInterpolator('some/url/{param1}/{param2}');
   *   fn({ param1: 123, param2: 456 }); // => 'some/url/123/456'
   */
  makeURLInterpolator: (() => {
    const rc = {
      '\n': '\\n',
      '"': '\\"',
      '\u2028': '\\u2028',
      '\u2029': '\\u2029',
    };
    return (str) => {
      const cleanString = str.replace(/["\n\r\u2028\u2029]/g, ($0) => rc[$0]);
      return (outputs) => {
        return cleanString.replace(/\{([\s\S]+?)\}/g, ($0, $1) =>
          encodeURIComponent(outputs[$1] || '')
        );
      };
    };
  })(),

  extractUrlParams: (path) => {
    const params = path.match(/\{\w+\}/g);
    if (!params) {
      return [];
    }

    return params.map((param) => param.replace(/[{}]/g, ''));
  },

  /**
   * Return the data argument from a list of arguments
   */
  getDataFromArgs: (args) => {
    if (args.length < 1 || !isPlainObject(args[0])) {
      return {};
    }

    if (!utils.isOptionsHash(args[0])) {
      return args.shift();
    }

    const argKeys = Object.keys(args[0]);

    const optionKeysInArgs = argKeys.filter((key) =>
      OPTIONS_KEYS.includes(key)
    );

    // In some cases options may be the provided as the first argument.
    // Here we're detecting a case where there are two distinct arguments
    // (the first being args and the second options) and with known
    // option keys in the first so that we can warn the user about it.
    if (
      optionKeysInArgs.length > 0 &&
      optionKeysInArgs.length !== argKeys.length
    ) {
      emitWarning(
        `Options found in arguments (${optionKeysInArgs.join(
          ', '
        )}). Did you mean to pass an options object? See https://github.com/stripe/stripe-node/wiki/Passing-Options.`
      );
    }

    return {};
  },

  /**
   * Return the options hash from a list of arguments
   */
  getOptionsFromArgs: (args) => {
    const opts = {
      auth: null,
      headers: {},
    };
    if (args.length > 0) {
      const arg = args[args.length - 1];
      if (typeof arg === 'string') {
        opts.auth = args.pop();
      } else if (utils.isOptionsHash(arg)) {
        const params = args.pop();

        const extraKeys = Object.keys(params).filter(
          (key) => !OPTIONS_KEYS.includes(key)
        );

        if (extraKeys.length) {
          emitWarning(
            `Invalid options found (${extraKeys.join(', ')}); ignoring.`
          );
        }

        if (params.api_key) {
          opts.auth = params.api_key;
        }
        if (params.idempotency_key) {
          opts.headers['Idempotency-Key'] = params.idempotency_key;
        }
        if (params.stripe_account) {
          opts.headers['Stripe-Account'] = params.stripe_account;
        }
        if (params.stripe_version) {
          opts.headers['Stripe-Version'] = params.stripe_version;
        }
      }
    }
    return opts;
  },

  /**
   * Provide simple "Class" extension mechanism
   */
  protoExtend(sub) {
    const Super = this;
    const Constructor = hasOwn.call(sub, 'constructor')
      ? sub.constructor
      : function(...args) {
          Super.apply(this, args);
        };

    // This initialization logic is somewhat sensitive to be compatible with
    // divergent JS implementations like the one found in Qt. See here for more
    // context:
    //
    // https://github.com/stripe/stripe-node/pull/334
    Object.assign(Constructor, Super);
    Constructor.prototype = Object.create(Super.prototype);
    Object.assign(Constructor.prototype, sub);

    return Constructor;
  },

  /**
   * Secure compare, from https://github.com/freewil/scmp
   */
  secureCompare: (a, b) => {
    a = Buffer.from(a);
    b = Buffer.from(b);

    // return early here if buffer lengths are not equal since timingSafeEqual
    // will throw if buffer lengths are not equal
    if (a.length !== b.length) {
      return false;
    }

    // use crypto.timingSafeEqual if available (since Node.js v6.6.0),
    // otherwise use our own scmp-internal function.
    if (crypto.timingSafeEqual) {
      return crypto.timingSafeEqual(a, b);
    }

    const len = a.length;
    let result = 0;

    for (let i = 0; i < len; ++i) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  },

  /**
   * Remove empty values from an object
   */
  removeEmpty: (obj) => {
    if (typeof obj !== 'object') {
      throw new Error('Argument must be an object');
    }

    Object.keys(obj).forEach((key) => {
      if (obj[key] === null || obj[key] === undefined) {
        delete obj[key];
      }
    });

    return obj;
  },

  /**
   * Determine if file data is a derivative of EventEmitter class.
   * https://nodejs.org/api/events.html#events_events
   */
  checkForStream: (obj) => {
    if (obj.file && obj.file.data) {
      return obj.file.data instanceof EventEmitter;
    }
    return false;
  },

  callbackifyPromiseWithTimeout: (promise, callback) => {
    if (callback) {
      // Ensure callback is called outside of promise stack.
      return promise.then(
        (res) => {
          setTimeout(() => {
            callback(null, res);
          }, 0);
        },
        (err) => {
          setTimeout(() => {
            callback(err, null);
          }, 0);
        }
      );
    }

    return promise;
  },

  /**
   * Allow for special capitalization cases (such as OAuth)
   */
  pascalToCamelCase: (name) => {
    if (name === 'OAuth') {
      return 'oauth';
    } else {
      return name[0].toLowerCase() + name.substring(1);
    }
  },

  emitWarning,

  /**
   * Node's built in `exec` function sometimes throws outright,
   * and sometimes has a callback with an error,
   * depending on the type of error.
   *
   * This unifies that interface.
   */
  safeExec: (cmd, cb) => {
    try {
      utils._exec(cmd, cb);
    } catch (e) {
      cb(e, null);
    }
  },

  // For mocking in tests.
  _exec: exec,

  isObject: (obj) => {
    const type = typeof obj;
    return (type === 'function' || type === 'object') && !!obj;
  },

  // For use in multipart requests
  flattenAndStringify: (data) => {
    const result = {};

    const step = (obj, prevKey) => {
      Object.keys(obj).forEach((key) => {
        const value = obj[key];

        const newKey = prevKey ? `${prevKey}[${key}]` : key;

        if (utils.isObject(value)) {
          if (!Buffer.isBuffer(value) && !value.hasOwnProperty('data')) {
            // Non-buffer non-file Objects are recursively flattened
            return step(value, newKey);
          } else {
            // Buffers and file objects are stored without modification
            result[newKey] = value;
          }
        } else {
          // Primitives are converted to strings
          result[newKey] = String(value);
        }
      });
    };

    step(data);

    return result;
  },
});

function emitWarning(warning) {
  if (typeof process.emitWarning !== 'function') {
    return console.warn(
      `Stripe: ${warning}`
    ); /* eslint-disable-line no-console */
  }

  return process.emitWarning(warning, 'Stripe');
}
