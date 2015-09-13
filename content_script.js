var echomsg = '(none)';
var errmsg = '[an error occurred while processing this directive]';
var reqenv = { };

function getContents(filename) {
	var xmlhttp = new XMLHttpRequest();
	xmlhttp.open("GET", filename, false);
	xmlhttp.send();
	console.log("Opening " + filename);
	return xmlhttp.responseText;
}

function initializeReqEnv() {
	reqenv['QUERY_STRING'] = window.location.search.replace(/^\?/, '');
	reqenv['PATH_INFO'] = null;
	// FIXME: implement these. grab from getContents()
	reqenv['DATE_GMT'] = null;
	reqenv['DATE_LOCAL'] = null;
	reqenv['DOCUMENT_NAME'] = null;
	reqenv['DOCUMENT_URI'] = null;
	reqenv['LAST_MODIFIED'] = null;
	reqenv['QUERY_STRING_UNESCAPED'] = null;	
}

function parseAttributes(args, isConditionalExpr) {
	// Apache has some strange handling of backslash. It only eats backslashes
	// if they're succeeded by the beginning quote character
	var r = /\s*(.+?)\s*=\s*(([\"\'\`])(.*?[^\\]|.{0})\3|[^\s]*)\s*/g;
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
			if (value[0] == '\"' || value[0] == '\'' || value[0] == '\`')
				throw 'Unterminated quote';
		}
		if (!isConditionalExpr)
			// FIXME: variable substitution
			;

		parsed.push(attribute);
		parsed.push(value);
		lastMatch = match.index + match[0].length;
	}
	// Apache doesn't seem to mind any characters after the last valid attribute
	// unless they are quotes or an equal sign
	if (/[=\"\'\`]/.test(args.substring(lastMatch)))
		throw 'Invalid arguments';
	return parsed;
}

function isWhitespace(text) {
	return text.replace(/^\s+|\s+$/gm,'').length === 0;
}

function processSet(args) {
	// FIXME: support encoding/decoding attribute
	if (args.length !== 4 || args[0] !== 'var' || args[2] !== 'value')
		throw 'Incorrect arguments';
	reqenv[args[1]] = args[3];
	return '';
}

function processEcho(args) {
	// FIXME: support encoding/decoding attribute
	if (args.length !== 2 || args[0] !== 'var')
		throw 'Incorrect arguments';
	if (reqenv.hasOwnProperty(args[1]))
		return reqenv[args[1]];
	else
		return echomsg;
}

function processInclude(args) {
	// FIXME: support onerror attribute
	// FIXME: NESTED INCLUDES NEEDS TO BE RELATIVE TO PATH OF LOADED DOC
	// FIXME: distinguish between file/virtual
	var i, didOne = false, output = '';
	for (i = 0; i < args.length; i += 2) {
		if (args[i] === 'virtual') {
			didOne = true;
			output += processShtml(getContents(args[i + 1]));
		} else if (args[i] === 'file') {
			didOne = true;
			output += processShtml(getContents(args[i + 1]));
		}
	}
	if (!didOne)
		throw 'Incorrect arguments';
	return output;
}

var PRECEDENCE_OPERAND = -1;
var PRECEDENCE_BRACKET = 0;
var PRECEDENCE_BOOLEAN = 1;
var PRECEDENCE_COMPARISON = 2;
var PRECEDENCE_ARITHMETIC = 3;
var PRECEDENCE_UNARY = 4;

// excludes restricted functions
var apExprFuncs = {
	req: function() { throw 'req() not implemented'; },
	http: function() { throw 'http() not implemented'; },
	req_novary: function() { throw 'req_novary() not implemented'; },
	resp: function() { throw 'resp() not implemented'; },
	reqenv: function(variable) { return reqenv[variable] || ''; },
	v: function(variable) { return reqenv[variable] || ''; },
	osenv: function() { throw 'osenv() not implemented'; },
	note: function() { throw 'note() not implemented'; },
	env: function() { throw 'env() not implemented'; },
	tolower: function(str) { return str.toLowerCase(); },
	toupper: function(str) { return str.toUpperCase(); },
	escape: encodeURIComponent,
	unescape: decodeURIComponent,
	base64: window.btoa,
	unbase64: window.atob,
	md5: function() { throw 'md5() not implemented'; },
	sha1: function() { throw 'sha1() not implemented'; }
};

// nothing equals NaN
var apExprVars = {
	HTTP_ACCEPT: NaN,
	HTTP_COOKIE: NaN,
	HTTP_FORWARDED: NaN,
	HTTP_HOST: NaN,
	HTTP_PROXY_CONNECTION: NaN,
	HTTP_REFERER: NaN,
	HTTP_USER_AGENT: NaN,
	REQUEST_METHOD: NaN,
	REQUEST_SCHEME: NaN,
	REQUEST_URI: NaN,
	DOCUMENT_URI: NaN,
	REQUEST_FILENAME: NaN,
	SCRIPT_FILENAME: NaN,
	LAST_MODIFIED: NaN,
	SCRIPT_USER: NaN,
	SCRIPT_GROUP: NaN,
	PATH_INFO: NaN,
	QUERY_STRING: NaN,
	IS_SUBREQ: NaN,
	THE_REQUEST: NaN,
	REMOTE_ADDR: NaN,
	REMOTE_HOST: NaN,
	REMOTE_USER: NaN,
	REMOTE_IDENT: NaN,
	SERVER_NAME: NaN,
	SERVER_PORT: NaN,
	SERVER_ADMIN: NaN,
	SERVER_PROTOCOL: NaN,
	DOCUMENT_ROOT: NaN,
	AUTH_TYPE: NaN,
	CONTENT_TYPE: NaN,
	HANDLER: NaN,
	HTTPS: NaN,
	IPV6: NaN,
	REQUEST_STATUS: NaN,
	REQUEST_LOG_ID: NaN,
	CONN_LOG_ID: NaN,
	CONN_REMOTE_ADDR: NaN,
	CONTEXT_PREFIX: NaN,
	CONTEXT_DOCUMENT_ROOT: NaN,
	TIME_YEAR: NaN,
	TIME_MON: NaN,
	TIME_DAY: NaN,
	TIME_HOUR: NaN,
	TIME_MIN: NaN,
	TIME_SEC: NaN,
	TIME_WDAY: NaN,
	TIME: NaN,
	SERVER_SOFTWARE: NaN,
	API_VERSION: NaN
}

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
	var functionWord = new RegExp(apExprFuncRegexStr, "i");
	// highest precedence binary operators
	var wordBinaryOp = /^\s*([\.,])/; // infix concatenation and wordlist delimiter
	// higher precedence binary operators. NOT case sensitive
	var compBinaryOp = /^\s*((\-?(eq|ne|lt|le|gt|ge|in)|\-(ipmatch|strmatch|strcmatch|fnmatch))(?!\w)|(=~|==?|!~|!=|<=?|>=?))/i;
	// lower precedence binary operators
	var exprBinaryOp = /^\s*(&&|\|\|)/;
	// misnomer in the BNF. matches multiple digits
	var digit = /^\s*(\d+)/;
	// not described in the BNF. FIXME: any escapes on \1 to be aware of?
	var regexp = /^\s*((m?\/.*?\/|m#.*?#)([A-Za-z]*))/;
	// brackets
	var exprGroup = /^\s*([\(\)\{\}])/;

	// quotes
	var stringGroup = /^\s*(['"])/;
	// variables and functions string interpolation. NOT case sensitive
	var variable = new RegExp(apExprVarRegexStr, "i");
	// regular expression backreference string interpolation
	var rebackref = /^\s*(\$\d)/;
	// any text within a word that's not a variable or rebackref of end of quote
	var cstring, baseCstring = /^\s*(((?!%\{\w*(:.*?)?\})(?!\$\d).)+)/;

	var i = 0;
	var match;
	var quoteChar = null, precededByStringPart = false;
	var tokens = [ ];
	while (expr != '') {
		startLen = expr.length;
		if (!quoteChar) {
			if (match = compUnaryOp.exec(expr)) {
				tokens.push(makeToken(match[1], PRECEDENCE_UNARY, "operator"));
				expr = expr.substring(match[0].length);
			}
			if (match = functionWord.exec(expr)) {
				if (match[3]) // valid syntax but invalid function name
					throw 'Unknown function call ' + match[3];

				tokens.push(makeToken(match[1], PRECEDENCE_UNARY, "function"));
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
				tokens.push(makeToken(match[1], PRECEDENCE_BOOLEAN));
				expr = expr.substring(match[0].length);
			}
			if (match = exprGroup.exec(expr)) {
				tokens.push(makeToken(match[1], PRECEDENCE_BRACKET));
				expr = expr.substring(match[0].length);
			}
			if (match = digit.exec(expr)) {
				tokens.push(makeToken(match[1], PRECEDENCE_OPERAND, "digit"));
				expr = expr.substring(match[0].length);
			}
			if (match = regexp.exec(expr)) {
				if (match[3] != '' && match[3] != 'i')
					throw 'Only the \'i\' flag is supported for regex';

				tokens.push(makeToken(match[1], PRECEDENCE_OPERAND, "regexp"));
				expr = expr.substring(match[0].length);
			}
		}

		if (match = stringGroup.exec(expr)) {
			if (quoteChar) {
				quoteChar = cstring = null;
				if (!precededByStringPart)
					tokens.push(makeToken('', PRECEDENCE_OPERAND, "string")); // token was just an empty string
				// make concatenation explicit and push that to parser. there
				// is no need for quotes, but assert order of operations
				tokens.push(makeToken(')', PRECEDENCE_BRACKET));
			} else {
				quoteChar = match[1];
				// FIXME: don't eat quotes if they are escaped
				cstring = new RegExp(baseCstring.source.substring(0, 6) + '(?!' + quoteChar + ')' + baseCstring.source.substring(6), baseCstring.flags);
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
					throw 'Unknown function call ' + match[6];
				else
					throw 'Unknown variable ' + match[6];

			if (quoteChar)
				if (precededByStringPart)
					tokens.push(makeToken('.', PRECEDENCE_ARITHMETIC)); // explicit concatenation
				else
					precededByStringPart = true;

			if (match[4]) {
				// interpolated function call
				tokens.push(makeToken(match[4], PRECEDENCE_UNARY, "function"));
				tokens.push(makeToken('(', PRECEDENCE_BRACKET));
				tokens.push(makeToken(match[5], PRECEDENCE_OPERAND, "string"));
				tokens.push(makeToken(')', PRECEDENCE_BRACKET));
			} else {
				// interpolated variable
				tokens.push(makeToken(match[2], PRECEDENCE_OPERAND, "variable"));
			}
			expr = expr.substring(match[0].length);
		}
		if (match = rebackref.exec(expr)) {
			if (quoteChar)
				if (precededByStringPart)
					tokens.push(makeToken('.', PRECEDENCE_ARITHMETIC)); // explicit concatenation
				else
					precededByStringPart = true;

			tokens.push(makeToken(match[1], PRECEDENCE_OPERAND, "backref"));
			expr = expr.substring(match[0].length);
		}

		if (quoteChar) {
			if (match = cstring.exec(expr)) {
				if (precededByStringPart)
					tokens.push(makeToken('.', PRECEDENCE_ARITHMETIC)); // explicit concatenation
				else
					precededByStringPart = true;

				tokens.push(makeToken(match[1], PRECEDENCE_OPERAND, "string"));
				expr = expr.substring(match[0].length);
			}
		}

		// no matches made
		if (expr.length == startLen)
			throw 'Syntax error: near "' + expr + '"';
	}

	if (quoteChar)
		throw 'Syntax error: unterminated string';
	return tokens;
}

// modified shunting yard algorithm. returns a postfix array of tokens
function parseExpr(expr) {
	// TODO: handle functions as unary operators
	// TODO: combine word lists to a single token
}

function evalExpr(expr) {
	
}

function processIf(args) {
	if (args.length !== 2 || args[0] !== 'expr')
		throw 'Incorrect arguments';
	console.log(tokenizeExpr(args[1]));
	return '';
}

function processElseIf(args) {
	if (args.length !== 2 || args[0] !== 'expr')
		throw 'Incorrect arguments';
	console.log(tokenizeExpr(args[1]));
	return '';
}

function processElse(args) {
	if (args.length !== 0)
		throw 'Incorrect arguments';
	return '';
}

function processEndIf(args) {
	if (args.length !== 0)
		throw 'Incorrect arguments';
	return '';
}

function processDirective(element, args) {
	try {
		args = parseAttributes(args);
		if (args === null)
			// Apache doesn't seem to write error message if the SSI directive
			// doesn't have the correct syntax. Only if the attributes and the
			// order of the attributes are wrong
			return '';

		switch (element) {
			case 'set':
				return processSet(args);
			case 'echo':
				return processEcho(args);
			case 'include':
				return processInclude(args);
			case 'if':
				return processIf(args);
			case 'elif':
				return processElseIf(args);
			case 'else':
				return processElse(args);
			case 'endif':
				return processEndIf(args);
			// FIXME: handle config, fsize, flastmod, printenv
			default:
				throw 'Unsupported directive: ' + element;
		}
	} catch (e) {
		console.log(e);
		return errmsg;
	}
}

function processShtml(input) {
	var r = /<!--\#(.*?)\s+(.*?)\s*-->/g;
	var output = input;
	var delta = 0;
	var match;
	while (match = r.exec(input)) {
		var replacement = processDirective(match[1], match[2]);
		output = output.substring(0, match.index + delta) + replacement + output.substring(match.index + delta + match[0].length, output.length);
		delta += replacement.length - match[0].length;
	}
	return output;
}

initializeReqEnv();
var processed = processShtml(getContents(window.location.href));

var newDoc = document.open('text/html', 'replace');
newDoc.write(processed);
newDoc.close();
