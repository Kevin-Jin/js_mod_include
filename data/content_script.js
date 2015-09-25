var echomsg = '(none)';
var errmsg = '[an error occurred while processing this directive]';
var reqenv = { };
var rebackref = [ ];
var currentCondStruct, rootCondStruct, path;
var switchedOutContext = [ ];

var lastFsize;

// perhaps based on Bourne shell and not BASH considering Apache escapes [^] (for pipe) but not [!%]
var shellMetaCharacters = /([\\\^$[\](){}<>"'`*?|&~#;])/g;

function normalizeFilename(filename) {
	if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(filename)) {
		// absolute URI or protocol relative
		return filename;
	} else if (/^\//.test(filename)) {
		// absolute on authority
		return filename;
	} else {
		// relative
		return (path ? path.substring(0, path.lastIndexOf('/') + 1) : '') + filename;
	}
}

function getContents(filename) {
	var xmlhttp = new XMLHttpRequest();
	xmlhttp.open('GET', filename, false);
	xmlhttp.overrideMimeType('text/plain; charset=x-user-defined');
	xmlhttp.send();
	apExprVars['REQUEST_METHOD'] = 'GET';
	apExprVars['LAST_MODIFIED'] = xmlhttp.getResponseHeader('Last-Modified');

	// we do the roundabout charset=x-user-defined followed by utf8.decode()
	// instead of just using charset=utf-8 so that xmlhttp.responseText.length
	// can be used for our fsize implementation
	lastFsize = xmlhttp.responseText.length;
	return utf8.decode(xmlhttp.responseText);
}

function initializeApExprVars() {
	// deep copy apExprVars
	apExprVars = JSON.parse(JSON.stringify(apExprVars));

	pad2 = function(x) { return ('0' + x).substring(x.length - 1); }
	pad4 = function(x) { return ('000' + x).substring(x.length - 1); }

	var year, mon, day, hour, min, sec
	apExprVars['TIME_YEAR'] = year = new Date().getFullYear();
	apExprVars['TIME_MON'] = mon = new Date().getMonth() + 1;
	apExprVars['TIME_DAY'] = day = new Date().getDate();
	apExprVars['TIME_HOUR'] = hour = new Date().getHours();
	apExprVars['TIME_MIN'] = min = new Date().getMinutes();
	apExprVars['TIME_SEC'] = sec = new Date().getSeconds();
	apExprVars['TIME_WDAY'] = new Date().getDay();
	apExprVars['TIME'] = pad4(year) + pad2(mon) + pad2(day) + pad2(hour) + pad2(min) + pad2(sec);

	var filenameSplit = /^(?:([a-z][a-z0-9+.-]*):)?(?:\/\/)?(.*)/i.exec(path), isSubreq;
	apExprVars['REQUEST_SCHEME'] = filenameSplit[1];
	apExprVars['SCRIPT_FILENAME'] = apExprVars['REQUEST_FILENAME']
			= apExprVars['DOCUMENT_URI'] = apExprVars['REQUEST_URI']
			= filenameSplit[2];
	if (filenameSplit[1].toLowerCase() == 'file') {
		filenameSplit = /^([\w\-\.]*)\/(.*)/.exec(filenameSplit[2]);
		if (filenameSplit[1] == '' || filenameSplit[1] == '127.0.0.1' || filenameSplit[1].toLowerCase() == 'localhost')
			apExprVars['SCRIPT_FILENAME'] = apExprVars['REQUEST_FILENAME'] = filenameSplit[2];
	}
	apExprVars['IS_SUBREQ'] = isSubreq = switchedOutContext.length > 1;
	apExprVars['QUERY_STRING'] = !isSubreq ? window.location.search.replace(/^\?/, '') : '';

	if (!isSubreq)
		// v('QUERY_STRING') == %{QUERY_STRING} && v('REQUEST_URI') == %{REQUEST_URI} && ...
		// on main request, but not on subrequests. implies reqenv only copies
		// selected values from apExprVars once, i.e. on the main request.
		initializeReqEnv();
}

function initializeReqEnv() {
	// FIXME: implement strftime
	reqenv['DATE_GMT'] = '';
	reqenv['DATE_LOCAL'] = '';
	reqenv['QUERY_STRING_UNESCAPED'] = decodeURIComponent(apExprVars['QUERY_STRING']).replace(shellMetaCharacters, '\\$1');
	reqenv['DOCUMENT_NAME'] = (path ? path.substring(path.lastIndexOf('/') + 1) : '');
	if (reqenv['DOCUMENT_NAME'].indexOf('?') !== -1)
		reqenv['DOCUMENT_NAME'] = reqenv['DOCUMENT_NAME'].substring(0, reqenv['DOCUMENT_NAME'].indexOf('?'));

	// includes from apExprVars
	for (var i = 0; i < apExprVarsIncludes.length; i++)
		reqenv[apExprVarsIncludes[i]] = apExprVars[apExprVarsIncludes[i]];
}

function parseAttributes(args) {
	// Apache has some strange handling of backslash. It only eats backslashes
	// if they're succeeded by the beginning quote character
	var r = /\s*(.+?)\s*=\s*((["'`])(.*?[^\\]|.{0})\3|[^\s]*)\s*/g;
	var match;
	var lastMatch = 0;
	var parsed = [ ];
	while (match = r.exec(args)) {
		if (match.index !== lastMatch)
			return null;

		var attribute = match[1];
		var value;
		if (match[3]) {
			// extract string inside quotes and eat backslashes
			value = match[4].replace('\\' + match[3], match[3]);
		} else {
			// non-quoted string
			value = match[2];
			if (value[0] === '\"' || value[0] === '\'' || value[0] === '\`')
				throw new Error('Unterminated quote');
		}

		parsed.push(attribute.toLowerCase());
		parsed.push(value);
		lastMatch = match.index + match[0].length;
	}
	// Apache doesn't seem to mind any characters after the last valid attribute
	// unless they are quotes or an equal sign
	if (/[="'`]/.test(args.substring(lastMatch)))
		throw new Error('Invalid arguments');
	return parsed;
}

function interpolateArguments(args) {
	// Apache has some strange handling of backslash. It only eats backslashes
	// if they're succeeded by the dollar sign character
	for (var i = 0; i < args.length; i += 2) {
		// interpolate regexp backreferences
		args[i + 1] = args[i + 1].replace(/(\\)\$|\$(?:(\w+)|\{(.*?)\})/g, function(match, p1, p2, p3, offset, string) {
			if (p1) // escaped dollar sign. eat the backslash
				if (match == '\\$')
					return '$';
				else
					throw new Error('Assertion failed.');

			var id = p2 || p3 || '';
			if (/^\d$/.test(id)) // single digit -> rebackref, even if rebackref[id] is undefined and reqenv[id] is defined
				return rebackref[id] || '';
			else
				return reqenv[id] || '';
		});
	}

	return args;
}

function makeRootCondStruct() {
	return {
		bounds: [ 0, Number.POSITIVE_INFINITY ],
		match: [ 0, Number.POSITIVE_INFINITY ],
		children: [ ],
		parent: null
	};
}

function pushCondStruct(begin, end, match) {
	currentCondStruct = {
		bounds: [ begin, end ],
		match: match,
		children: [ ],
		parent: currentCondStruct
	};
	currentCondStruct.parent.children.push(currentCondStruct);
	return currentCondStruct;
}

function popCondStruct() {
	var thisCondStruct = currentCondStruct;
	currentCondStruct = currentCondStruct.parent;
	return thisCondStruct;
}

// so that we don't execute a directive if we're in the false part of a branch
function isDeadBlock(offset, thisCondStruct) {
	thisCondStruct = thisCondStruct || currentCondStruct;

	if (thisCondStruct && thisCondStruct.match && (offset < thisCondStruct.match[0] || thisCondStruct.match[1] !== Number.POSITIVE_INFINITY && offset >= thisCondStruct.bounds[1]))
		throw new Error('Invalid isDeadBlock() check');

	return (thisCondStruct && (
		!thisCondStruct.match || offset < thisCondStruct.match[0]
		|| thisCondStruct.match[1] !== Number.POSITIVE_INFINITY && offset >= thisCondStruct.match[1]
	));
}

function processSet(args, offset) {
	args = interpolateArguments(args);
	// FIXME: support encoding/decoding attribute
	if (args.length !== 4 || args[0] !== 'var' || args[2] !== 'value')
		throw new Error('Incorrect arguments');

	if (!isDeadBlock(offset))
		reqenv[args[1]] = args[3];

	return '';
}

function processEcho(args, offset) {
	args = interpolateArguments(args);
	// FIXME: support encoding/decoding attribute
	if (args.length !== 2 || args[0] !== 'var')
		throw new Error('Incorrect arguments');

	if (isDeadBlock(offset))
		return '';

	var id = args[1];
	if (/^\d$/.test(id)) // single digit -> rebackref, even if rebackref[id] is undefined and reqenv[id] is defined
		if ((id = parseInt(id)) < rebackref.length)
			return rebackref[id] || '';
		else
			return echomsg;
	else
		if (reqenv.hasOwnProperty(id))
			return reqenv[id];
		else
			return echomsg;
}

function processInclude(args, offset) {
	args = interpolateArguments(args);
	// FIXME: support onerror attribute
	// FIXME: 'file' can't begin with '/' or have any '../'
	// FIXME: 'virtual' can have percent encoded QUERY_STRING. can't begin with URI scheme or authority
	var i, didOne = false, output = '';
	for (i = 0; i < args.length; i += 2) {
		if (args[i] === 'virtual') {
			didOne = true;
			if (!isDeadBlock(offset))
				output += processShtml(getContents(normalizeFilename(args[i + 1])), normalizeFilename(args[i + 1]));
		} else if (args[i] === 'file') {
			didOne = true;
			if (!isDeadBlock(offset))
				output += processShtml(getContents(normalizeFilename(args[i + 1])), normalizeFilename(args[i + 1]));
		}
	}
	if (!didOne)
		throw new Error('Incorrect arguments');
	return output;
}

var PRECEDENCE_OPERAND = -1;
var PRECEDENCE_BRACKET = 0;
var PRECEDENCE_LIST = 1;
var PRECEDENCE_BOOLEAN = {
	'||': 2,
	'&&': 3
};
var PRECEDENCE_COMPARISON = 4;
var PRECEDENCE_ARITHMETIC = 5;
var PRECEDENCE_UNARY = 6;

// excludes restricted functions
var apExprFuncs = {
	req: function() { throw new Error('req() not implemented'); },
	http: function() { throw new Error('http() not implemented'); },
	req_novary: function() { throw new Error('req_novary() not implemented'); },
	resp: function() { throw new Error('resp() not implemented'); },
	reqenv: function(variable) { return reqenv[variable] || ''; },
	v: function(variable) { return reqenv[variable] || ''; },
	osenv: function() { throw new Error('osenv() not implemented'); },
	note: function() { throw new Error('note() not implemented'); },
	env: function(variable) { return reqenv[variable] || ''; },
	tolower: function(str) { return str.toLowerCase(); },
	toupper: function(str) { return str.toUpperCase(); },
	escape: encodeURIComponent,
	unescape: decodeURIComponent,
	base64: window.btoa,
	unbase64: window.atob,
	md5: function() { throw new Error('md5() not implemented'); },
	sha1: function() { throw new Error('sha1() not implemented'); }
};

// nothing equals NaN
var apExprVars = {
	// see apExprVarsIncludes
	HTTP_ACCEPT: NaN,
	HTTP_COOKIE: NaN, // not sure if is include variable
	HTTP_FORWARDED: NaN, // not sure if is include variable
	HTTP_HOST: NaN,
	HTTP_PROXY_CONNECTION: NaN, // not sure if is include variable
	HTTP_REFERER: document.referrer, // not sure if is include variable
	HTTP_USER_AGENT: navigator.userAgent,
	REQUEST_METHOD: 'GET',
	REQUEST_SCHEME: NaN,
	REQUEST_URI: NaN,
	DOCUMENT_URI: NaN,
	SCRIPT_FILENAME: NaN,
	LAST_MODIFIED: NaN,
	PATH_INFO: NaN, // not sure if is include variable
	QUERY_STRING: NaN,
	REMOTE_ADDR: NaN,
	REMOTE_USER: NaN, // not sure if is include variable
	REMOTE_IDENT: NaN,
	SERVER_NAME: window.location.hostname, // #include can't specify URI authorities, so this is constant
	SERVER_PORT: parseInt(window.location.port || 80), // #include can't specify URI authorities, so this is constant
	SERVER_ADMIN: NaN, // email address
	SERVER_PROTOCOL: 'HTTP/1.1',
	DOCUMENT_ROOT: '/',
	AUTH_TYPE: NaN, // not sure if is include variable
	CONTEXT_PREFIX: NaN, // not sure if is include variable
	CONTEXT_DOCUMENT_ROOT: NaN,
	SERVER_SOFTWARE: typeof chrome !== 'undefined' ? 'js_mod_include ' + chrome.runtime.getManifest().version : 'js_mod_include',

	// not copied into reqenv on main request
	REQUEST_FILENAME: NaN,
	SCRIPT_USER: NaN,
	SCRIPT_GROUP: NaN,
	IS_SUBREQ: NaN,
	THE_REQUEST: NaN,
	REMOTE_HOST: NaN,
	CONTENT_TYPE: NaN, // text/html
	HANDLER: NaN, // text/html
	HTTPS: 'off',
	IPV6: 'off',
	REQUEST_STATUS: 200,
	REQUEST_LOG_ID: NaN, // not sure if is NOT include variable
	CONN_LOG_ID: NaN,
	CONN_REMOTE_ADDR: NaN,
	TIME_YEAR: NaN,
	TIME_MON: NaN,
	TIME_DAY: NaN,
	TIME_HOUR: NaN,
	TIME_MIN: NaN,
	TIME_SEC: NaN,
	TIME_WDAY: NaN,
	TIME: NaN,
	API_VERSION: NaN
}

// copied into reqenv on main request
var apExprVarsIncludes = [ 'HTTP_ACCEPT', 'HTTP_COOKIE', 'HTTP_FORWARDED',
	'HTTP_HOST', 'HTTP_PROXY_CONNECTION', 'HTTP_REFERER', 'HTTP_USER_AGENT',
	'REQUEST_METHOD', 'REQUEST_SCHEME', 'REQUEST_URI', 'DOCUMENT_URI',
	'SCRIPT_FILENAME', 'LAST_MODIFIED', 'PATH_INFO', 'QUERY_STRING',
	'REMOTE_ADDR', 'REMOTE_USER', 'REMOTE_IDENT', 'SERVER_NAME', 'SERVER_PORT',
	'SERVER_ADMIN', 'SERVER_PROTOCOL', 'DOCUMENT_ROOT', 'AUTH_TYPE',
	'CONTEXT_PREFIX', 'CONTEXT_DOCUMENT_ROOT', 'SERVER_SOFTWARE'
];

function getNames(obj) {
	var r = [ ];
	for (var k in obj) {
		if (!obj.hasOwnProperty(k))
			continue;
		r.push(k);
	}
	return r;
}

var apExprFuncRegexStr = '^\\s*((' + getNames(apExprFuncs).join('|') + ')(?!\\w)|(\\w*))\\s*(?=\\()';
var apExprVarRegexStr = '^\\s*(%\\{('
	+ '(' + getNames(apExprVars).join('|') + ')(?!\\w)'
	// interpolated function
	+ '|(' + getNames(apExprFuncs).join('|') + '):(.*?)'
	+ '|(\\w*(:.*?)?)'
	+ ')\\})';

function makeToken(text, precedence, type) {
	return {
		text: text,
		precedence: precedence,
		type: type
	};
}

// http://httpd.apache.org/docs/current/expr.html
// https://github.com/omnigroup/Apache/blob/master/httpd/server/util_expr_eval.c
function tokenizeExpr(expr) {
	// excludes restricted unary operators. case sensitive
	var compUnaryOp = /^\s*(\-(F|U|n|z|T|R|A)(?!\w)|!(?![=~]))/;
	// function names followed by a (non-captured) opening parenthesis. NOT case sensitive
	var functionWord = new RegExp(apExprFuncRegexStr, 'i');
	// highest precedence binary operators
	var wordBinaryOp = /^\s*(\.)/;
	// higher precedence binary operators. NOT case sensitive
	var compBinaryOp = /^\s*((\-?(eq|ne|lt|le|gt|ge|in)|\-(ipmatch|strmatch|strcmatch|fnmatch))(?!\w)|(=~|==?|!~|!=|<=?|>=?))/i;
	// lower precedence binary operators
	var exprBinaryOp = /^\s*(&&|\|\|)/;
	// lowest precedence binary operators
	var wordlistBinaryOp = /^\s*(,)/;
	// brackets
	var exprGroup = /^\s*([\(\)\{\}])/;
	// misnomer in the BNF. matches multiple digits
	var digit = /^\s*(\d+)/;
	// true or false
	var bool = /^\s*(true|false)/;
	// not described in the BNF
	var regexp = /^\s*((\/(.*?)\/|m(.)(.*?)\4)([A-Za-z]*))/;

	// quotes
	var stringGroup = /^\s*(["'])/;
	// variables and functions string interpolation. NOT case sensitive
	var variable = new RegExp(apExprVarRegexStr, 'i');
	// regular expression backreference string interpolation
	var rebackref = /^\s*(\$\d)/;
	// any text within a word that's not a (unescaped) variable, rebackref, or end of quote
	var cstring, baseCstring = /^\s*((\\.|(?!\\)(?!%\{\w*(:.*?)?\})(?!\$\d).)+)/;

	var i = 0;
	var match;
	var precededByStringPart = false;
	var tokens = [ ];
	while (expr !== '') {
		startLen = expr.length;
		if (!cstring) {
			if (match = compUnaryOp.exec(expr)) {
				tokens.push(makeToken(match[1], PRECEDENCE_UNARY, 'operator'));
				expr = expr.substring(match[0].length);
			}
			if (match = functionWord.exec(expr)) {
				if (match[3]) // valid syntax but invalid function name
					throw new Error('Unknown function call ' + match[3]);

				tokens.push(makeToken(match[1], PRECEDENCE_UNARY, 'function'));
				expr = expr.substring(match[0].length);
			}
			if (match = wordBinaryOp.exec(expr)) {
				tokens.push(makeToken(match[1], PRECEDENCE_ARITHMETIC));
				expr = expr.substring(match[0].length);
			}
			if (match = compBinaryOp.exec(expr)) {
				tokens.push(makeToken(match[1], PRECEDENCE_COMPARISON));
				expr = expr.substring(match[0].length);
			}
			if (match = exprBinaryOp.exec(expr)) {
				tokens.push(makeToken(match[1], PRECEDENCE_BOOLEAN[match[1]]));
				expr = expr.substring(match[0].length);
			}
			if (match = wordlistBinaryOp.exec(expr)) {
				tokens.push(makeToken(match[1], PRECEDENCE_LIST));
				expr = expr.substring(match[0].length);
			}
			if (match = exprGroup.exec(expr)) {
				tokens.push(makeToken(match[1], PRECEDENCE_BRACKET));
				expr = expr.substring(match[0].length);
			}
			if (match = digit.exec(expr)) {
				// parseInt() is not used because leading 0s can be significant
				// e.g. (001 == '001') is true but (01 == '001') is false.
				tokens.push(makeToken(match[1], PRECEDENCE_OPERAND, 'digit'));
				expr = expr.substring(match[0].length);
			}
			if (match = bool.exec(expr)) {
				tokens.push(makeToken(Boolean(match[1]), PRECEDENCE_OPERAND, 'boolean'));
				expr = expr.substring(match[0].length);
			}
			if (match = regexp.exec(expr)) {
				if (match[6] !== '' && match[6] !== 'i')
					throw new Error('Only the \'i\' flag is supported for regex');

				tokens.push(makeToken(new RegExp(match[3] || match[5], match[6]), PRECEDENCE_OPERAND, 'regexp'));
				expr = expr.substring(match[0].length);
			}
		}

		if (match = stringGroup.exec(expr)) {
			if (cstring) {
				cstring = null;
				if (!precededByStringPart)
					tokens.push(makeToken('', PRECEDENCE_OPERAND, 'string')); // token was just an empty string
				// make concatenation explicit and push that to parser. there
				// is no need for quotes, but assert order of operations
				tokens.push(makeToken(')', PRECEDENCE_BRACKET));
			} else {
				// text within word must not match our (unescaped) quote character
				cstring = new RegExp(baseCstring.source.substring(0, 10) + '(?!' + match[1] + ')' + baseCstring.source.substring(10), baseCstring.flags);
				// make concatenation explicit and push that to parser. there
				// is no need for quotes, but assert order of operations
				tokens.push(makeToken('(', PRECEDENCE_BRACKET));
			}
			precededByStringPart = false;

			expr = expr.substring(match[0].length);
		}
		if (match = variable.exec(expr)) {
			if (match[6]) // valid syntax but invalid variable/function name
				if (match[7])
					throw new Error('Unknown function call ' + match[6]);
				else
					throw new Error('Unknown variable ' + match[6]);

			if (cstring)
				if (precededByStringPart)
					tokens.push(makeToken('.', PRECEDENCE_ARITHMETIC)); // explicit concatenation
				else
					precededByStringPart = true;

			if (match[4]) {
				// interpolated function call
				tokens.push(makeToken(match[4], PRECEDENCE_UNARY, 'function'));
				tokens.push(makeToken('(', PRECEDENCE_BRACKET));
				tokens.push(makeToken(match[5], PRECEDENCE_OPERAND, 'string'));
				tokens.push(makeToken(')', PRECEDENCE_BRACKET));
			} else {
				// interpolated variable
				tokens.push(makeToken(match[2], PRECEDENCE_OPERAND, 'variable'));
			}
			expr = expr.substring(match[0].length);
		}
		if (match = rebackref.exec(expr)) {
			if (cstring)
				if (precededByStringPart)
					tokens.push(makeToken('.', PRECEDENCE_ARITHMETIC)); // explicit concatenation
				else
					precededByStringPart = true;

			tokens.push(makeToken(match[1], PRECEDENCE_OPERAND, 'backref'));
			expr = expr.substring(match[0].length);
		}

		if (cstring) {
			if (match = cstring.exec(expr)) {
				if (precededByStringPart)
					tokens.push(makeToken('.', PRECEDENCE_ARITHMETIC)); // explicit concatenation
				else
					precededByStringPart = true;

				// ap_expr backslash inside string escapes ANY character, so
				// just eat all backslash characters
				tokens.push(makeToken(match[1].replace(/\\(.)/g, "$1"), PRECEDENCE_OPERAND, 'string'));
				expr = expr.substring(match[0].length);
			}
		}

		// no matches made
		if (expr.length === startLen)
			throw new Error('Syntax error: near "' + expr + '"');
	}

	if (cstring)
		throw new Error('Syntax error: unterminated string');
	return tokens;
}

// shunting yard algorithm. returns a postfix array of tokens
function parseExpr(expr) {
	var outputQueue = [ ];
	var operatorStack = [ ];

	for (var i = 0; i < expr.length; i++) {
		var token = expr[i];
		if (token.precedence > PRECEDENCE_BRACKET) {
			// pop all operations that must occur before our's
			var stackOp = null;
			while (operatorStack.length !== 0 && (stackOp = operatorStack.pop()).precedence > token.precedence) {
				outputQueue.push(stackOp);
				stackOp = null;
			}
			// took one too many
			if (stackOp !== null)
				operatorStack.push(stackOp);
			// push ourselves
			operatorStack.push(token);
		} else if (token.precedence === PRECEDENCE_BRACKET) {
			switch (token.text) {
				case '(':
				case '{':
					operatorStack.push(token);
					break;
				case ')':
				case '}': {
					// pop all operations that must occur before next operator
					var match;
					switch (token.text) {
						case ')':
							match = '(';
							break;
						case '}':
							match = '{';
							break;
					}

					var stackOp = null;
					while (operatorStack.length !== 0 && (stackOp = operatorStack.pop()).text !== match)
						outputQueue.push(stackOp);
					if (operatorStack.length === 0 && stackOp.text !== match)
						throw new Error('Mismatched brackets');
					break;
				}
			}
		} else {
			if (token.precedence !== PRECEDENCE_OPERAND)
				throw new Error('Unknown token ' + token.text);
			outputQueue.push(token);
		}
	}
	// pop all remaining operations
	while (operatorStack.length !== 0) {
		var stackOp = operatorStack.pop();
		if (stackOp === '(' || stackOp === '{')
			throw new Error('Mismatched brackets');
		outputQueue.push(stackOp);
	}
	return outputQueue;
}

function applyUnaryFunction(func, operand) {
	if (func.type === 'function')
		return makeToken(apExprFuncs[func.text](operand.text), PRECEDENCE_OPERAND, 'string');

	switch (func.text) {
		case '!':
			if (operand.type !== 'boolean')
				throw new Error('Cannot operate on non-booleans');
			return makeToken(!operand.text, PRECEDENCE_OPERAND, 'boolean');
		case '-U':
		case '-A':
			throw func.text + ' not implemented';
		case '-n':
			return makeToken(operand.text.length !== 0, PRECEDENCE_OPERAND, 'boolean');
		case '-z':
			return makeToken(operand.text.length === 0, PRECEDENCE_OPERAND, 'boolean');
		case '-T':
			return makeToken(operand.text == false || operand.text === 'off' || operand.text === 'no', PRECEDENCE_OPERAND, 'boolean');
		default:
			throw func.text + ' not implemented';
	}
}

function falsyIndexOf(array, searchElement, fromIndex) {
	var O = Object(array);
	var len = O.length >>> 0;
	if (len === 0)
		return -1;

	var n = +fromIndex || 0;
	if (Math.abs(n) === Infinity)
		n = 0;
	if (n >= len)
		return -1;

	for (var k = Math.max(n >= 0 ? n : len - Math.abs(n), 0); k < len; k++)
		if (k in O && O[k].text == searchElement)
			return k;
	return -1;
}

function cloneToken(token) {
	if (Array.isArray(token.text))
		return makeToken(token.text.slice(0), token.precedence, token.type);
	else
		return makeToken(token.text, token.precedence, token.type);
}

function applyBinaryFunction(func, operand1, operand2) {
	switch (func.text) {
		// string operations
		case '.':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot concatenate non-alphanumerics');

			return makeToken('' + operand1.text + operand2.text, PRECEDENCE_OPERAND, 'string');
		// wordlist operations
		case ',':
			if (operand1.type === 'digit' || operand1.type === 'string')
				operand1 = makeToken([ operand1 ], PRECEDENCE_OPERAND, 'wordlist');
			else if (operand1.type === 'wordlist')
				operand1 = cloneToken(operand1); // prevent side effects
			else
				throw new Error('Cannot concatenate non-alphanumerics');

			if (operand2.type === 'digit' || operand2.type === 'string')
				operand1.text.push(operand2);
			else if (operand2.type === 'wordlist')
				Array.prototype.push.apply(operand1.text, operand2.text);
			else
				throw new Error('Cannot concatenate non-alphanumerics');

			return operand1;
		case 'in':
		case '-in':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'wordlist')
				throw new Error('Second operand of -in must be a wordlist');
			return makeToken(falsyIndexOf(operand2.text, operand1.text) !== -1, PRECEDENCE_OPERAND, 'boolean');
		// string comparisons
		case '=':
		case '==':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(operand1.text.localeCompare(operand2.text) === 0, PRECEDENCE_OPERAND, 'boolean');
		case '!=':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(operand1.text.localeCompare(operand2.text) !== 0, PRECEDENCE_OPERAND, 'boolean');
		case '<':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(operand1.text.localeCompare(operand2.text) < 0, PRECEDENCE_OPERAND, 'boolean');
		case '<=':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(operand1.text.localeCompare(operand2.text) <= 0, PRECEDENCE_OPERAND, 'boolean');
		case '>':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(operand1.text.localeCompare(operand2.text) > 0, PRECEDENCE_OPERAND, 'boolean');
		case '>=':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(operand1.text.localeCompare(operand2.text) >= 0, PRECEDENCE_OPERAND, 'boolean');
		// integer comparisons
		// Apache conveniently also stops reading characters after the first
		// non-numeric character in a string, just like parseInt()
		case 'eq':
		case '-eq':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(parseInt(operand1.text) === parseInt(operand2.text), PRECEDENCE_OPERAND, 'boolean');
		case 'ne':
		case '-ne':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(parseInt(operand1.text) !== parseInt(operand2.text), PRECEDENCE_OPERAND, 'boolean');
		case 'lt':
		case '-lt':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(parseInt(operand1.text) < parseInt(operand2.text), PRECEDENCE_OPERAND, 'boolean');
		case 'le':
		case '-le':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(parseInt(operand1.text) <= parseInt(operand2.text), PRECEDENCE_OPERAND, 'boolean');
		case 'gt':
		case '-gt':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(parseInt(operand1.text) > parseInt(operand2.text), PRECEDENCE_OPERAND, 'boolean');
		case 'ge':
		case '-ge':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'digit' && operand2.type !== 'string')
				throw new Error('Cannot compare non-alphanumerics');
			return makeToken(parseInt(operand1.text) >= parseInt(operand2.text), PRECEDENCE_OPERAND, 'boolean');
		// regex comparisons
		case '=~':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'regexp')
				throw new Error('Second operand of =~ must be regexp');
			rebackref = operand2.text.exec(operand1.text) || [ ];
			return makeToken(rebackref != false, PRECEDENCE_OPERAND, 'boolean');
		case '!~':
			if (operand1.type !== 'digit' && operand1.type !== 'string'
					|| operand2.type !== 'regexp')
				throw new Error('Second operand of !~ must be regexp');
			rebackref = operand2.text.exec(operand1.text) || [ ];
			return makeToken(rebackref == false, PRECEDENCE_OPERAND, 'boolean');
		// boolean operators
		case '&&':
			if (operand1.type !== 'boolean' && operand2.type !== 'boolean')
				throw new Error('Cannot operate on non-booleans');
			return makeToken(operand1.text && operand2.text, PRECEDENCE_OPERAND, 'boolean');
		case '||':
			if (operand1.type !== 'boolean' && operand2.type !== 'boolean')
				throw new Error('Cannot operate on non-booleans');
			return makeToken(operand1.text || operand2.text, PRECEDENCE_OPERAND, 'boolean');
		default:
			throw func.text + ' not implemented';
	}
}

function evalExpr(expr) {
	var evaluationStack = [ ];

	for (var i = 0; i < expr.length; i++) {
		var token = expr[i];
		switch (token.precedence) {
			case PRECEDENCE_OPERAND: {
				// general operand -> primitive operand
				switch (token.type) {
					case 'variable':
						evaluationStack.push(makeToken(apExprVars[token.text], PRECEDENCE_OPERAND, 'string'));
						break;
					case 'backref':
						evaluationStack.push(makeToken(rebackref[parseInt(token.text[1])], PRECEDENCE_OPERAND, 'string'));
						break;
					default: // string, digit, boolean, regexp, wordlist
						evaluationStack.push(token);
						break;
				}
				break;
			}
			case PRECEDENCE_UNARY: {
				// unary function
				var operand = evaluationStack.pop();
				evaluationStack.push(applyUnaryFunction(token, operand));
				break;
			}
			default: {
				// binary function
				var operand2 = evaluationStack.pop();
				var operand1 = evaluationStack.pop();
				evaluationStack.push(applyBinaryFunction(token, operand1, operand2));
				break;
			}
			case PRECEDENCE_BRACKET: {
				// bracket carried over from infix expression
				throw new Error('Bracket cannot be in eval string');
			}
		}
	}

	if (evaluationStack.length !== 1)
		throw new Error('Syntax error');
	var result = evaluationStack.pop();
	if (result.precedence != PRECEDENCE_OPERAND || result.type !== 'boolean')
		throw new Error('Syntax error');

	return result.text;
}

function processIf(args, offset) {
	if (args.length !== 2 || args[0] !== 'expr')
		throw new Error('Incorrect arguments');

	pushCondStruct(
		offset, Number.POSITIVE_INFINITY,
		!isDeadBlock(offset) && evalExpr(parseExpr(tokenizeExpr(args[1]))) ? [ offset, Number.POSITIVE_INFINITY ] : null
	);
	return '';
}

function processElseIf(args, offset) {
	if (args.length !== 2 || args[0] !== 'expr')
		throw new Error('Incorrect arguments');

	if (currentCondStruct === rootCondStruct) {
		// Apache just creates implicit "if" at start of file with expr="true"
		pushCondStruct(
			0, Number.POSITIVE_INFINITY,
			[ 0, offset ]
		);
	}

	if (currentCondStruct.match) {
		if (currentCondStruct.match[1] === Number.POSITIVE_INFINITY)
			currentCondStruct.match[1] = offset;
	} else if (!isDeadBlock(offset, currentCondStruct.parent) && evalExpr(parseExpr(tokenizeExpr(args[1])))) {
		// Apache doesn't throw an error if "elif" follows an "else". it looks
		// like it just ignores any branch directive after the first match. e.g.
		// in the case of "if"-"else" before "elif", one of those two branches
		// must have been followed, so we ignore this "elif". so no need for us
		// to have any kind of error trapping or other checks
		currentCondStruct.match = [ offset, Number.POSITIVE_INFINITY ];
	}
	return '';
}

function processElse(args, offset) {
	if (args.length !== 0)
		throw new Error('Incorrect arguments');

	if (currentCondStruct === rootCondStruct) {
		// Apache just creates implicit "if" at start of file with expr="true"
		pushCondStruct(
			0, Number.POSITIVE_INFINITY,
			[ 0, offset ]
		);
	}

	if (currentCondStruct.match) {
		if (currentCondStruct.match[1] === Number.POSITIVE_INFINITY)
			currentCondStruct.match[1] = offset;
	} else if (!isDeadBlock(offset, currentCondStruct.parent)) {
		// Apache doesn't throw an error if "else" follows an "else". it looks
		// like it just ignores any branch directive after the first match. e.g.
		// in the case of "if"-"else" before "else", one of those two branches
		// must have been followed, so we ignore this "else". so no need for us
		// to have any kind of error trapping or other checks
		currentCondStruct.match = [ offset, Number.POSITIVE_INFINITY ];
	}
	return '';
}

function processEndIf(args, offset) {
	if (args.length !== 0)
		throw new Error('Incorrect arguments');

	if (currentCondStruct !== rootCondStruct) {
		currentCondStruct.bounds[1] = offset;
		if (currentCondStruct.match && currentCondStruct.match[1] === Number.POSITIVE_INFINITY)
			currentCondStruct.match[1] = offset;

		if (isDeadBlock(offset, currentCondStruct.parent) && currentCondStruct.match)
			throw new Error('(el)if should not be evaluated in dead branch');

		popCondStruct();
	}
	// Apache doesn't throw an error if "endif" does not follow an "if"

	return '';
}

function processDirective(element, args, offset) {
	try {
		args = parseAttributes(args || '');
		if (args === null)
			// Apache doesn't seem to write error message if the SSI directive
			// doesn't have the correct syntax. Only if the attributes and the
			// order of the attributes are wrong
			return '';

		switch (element) {
			case 'set':
				return processSet(args, offset);
			case 'echo':
				return processEcho(args, offset);
			case 'include':
				return processInclude(args, offset);
			case 'if':
				return processIf(args, offset);
			case 'elif':
				return processElseIf(args, offset);
			case 'else':
				return processElse(args, offset);
			case 'endif':
				return processEndIf(args, offset);
			// FIXME: handle config, fsize, flastmod, printenv
			default:
				throw new Error('Unsupported directive: ' + element);
		}
	} catch (e) {
		console.error(e.stack);
		return errmsg;
	}
}

function processShtml(input, filename) {
	switchedOutContext.push([ rootCondStruct, currentCondStruct, path, apExprVars ]);
	currentCondStruct = rootCondStruct = makeRootCondStruct();
	path = filename;
	initializeApExprVars();
	console.log('BEGIN ' + filename);

	var r = /<!--\#(.*?)(?:\s+(.*?))?\s*-->/g;
	var output = input;
	var delta = 0;
	var match;
	while (match = r.exec(input)) {
		var offset = match.index + delta;
		var directiveLen = match[0].length;
		var replacement = processDirective(match[1].toLowerCase(), match[2], offset);
		output = output.substring(0, offset) + replacement + output.substring(offset + directiveLen, output.length);
		delta += replacement.length - directiveLen;
	}
	while (currentCondStruct !== rootCondStruct)
		// Apache does't throw an error if "if" is not followed by "endif"
		processEndIf([ ], input.length + delta);

	// post-order depth-first traversal, implemented non-recursively.
	// trims if-(elif)-else statements from top-to-bottom, nested-to-enclosing.
	// that way, we can interpret the delta variable as simply the value that
	// unvisited indices (right siblings of current node, and right siblings of
	// all ancestors of current node) are offset by in the transformed output.
	var nodes = [ rootCondStruct ];
	var visited = [ ];
	while (nodes.length !== 0) {
		var node = nodes.pop();
		visited.push(node);
		for (var i = 0; i < node.children.length; i++)
			nodes.push(node.children[i]);
	}
	delta = 0;
	while (visited.length !== 0) {
		var node = visited.pop();
		if (node.match) {
			output = output.substring(0, node.bounds[0] + delta)
					+ output.substring(node.match[0] + delta, node.match[1] + delta)
					+ output.substring(node.bounds[1] + delta, output.length);
			delta -= (node.match[0] - node.bounds[0]) + (node.bounds[1] - node.match[1]);
		} else {
			output = output.substring(0, node.bounds[0] + delta)
					+ output.substring(node.bounds[1] + delta, output.length);
			delta -= - node.bounds[0] + node.bounds[1];
		}
	}

	console.log('END ' + path);
	var context = switchedOutContext.pop();
	rootCondStruct = context[0];
	currentCondStruct = context[1];
	path = context[2];
	apExprVars = context[3];
	return output;
}

document.documentElement.style.visibility = 'hidden';
var processed = processShtml(getContents(normalizeFilename(window.location.href)), normalizeFilename(window.location.href));

try {
	var newDoc = (typeof unsafeWindow  === 'undefined' ? window : unsafeWindow).document.open('text/html', 'replace');
	newDoc.write(processed);
	newDoc.close();
} catch(e) {
	console.error(e.message);
	if (e.name === 'SecurityError') {
		var script = document.createElement('script');
		script.innerHTML = 'var newDoc = document.open("text/html", "replace"); newDoc.write(' + JSON.stringify(processed) + '); newDoc.close();';
		document.body.appendChild(script);
	}
}
