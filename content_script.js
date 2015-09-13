var echomsg = '(none)';
var errmsg = '[an error occurred while processing this directive]';
var vars = { };

function getContents(filename) {
	var xmlhttp = new XMLHttpRequest();
	xmlhttp.open("GET", filename, false);
	xmlhttp.send();
	console.log("Opening " + filename);
	return xmlhttp.responseText;
}

function setBaseVars() {
	vars['QUERY_STRING'] = window.location.search.replace(/^\?/, '');
	vars['PATH_INFO'] = null;
	// FIXME: implement these. grab from getContents()
	vars['DATE_GMT'] = null;
	vars['DATE_LOCAL'] = null;
	vars['DOCUMENT_NAME'] = null;
	vars['DOCUMENT_URI'] = null;
	vars['LAST_MODIFIED'] = null;
	vars['QUERY_STRING_UNESCAPED'] = null;	
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
	vars[args[1]] = args[3];
	return '';
}

function processEcho(args) {
	// FIXME: support encoding/decoding attribute
	if (args.length !== 2 || args[0] !== 'var')
		throw 'Incorrect arguments';
	if (vars.hasOwnProperty(args[1]))
		return vars[args[1]];
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

function processDirective(element, args) {
	try {
		if (isWhitespace(args))
			throw 'No arguments passed';
		args = parseAttributes(args);
		if (args === null)
			// Apache doesn't seem to write error message if the SSI directive
			// doesn't have the correct syntax. Only if the attributes and the
			// order of the attributes are wrong
			return '';
		if (args.length === 0)
			throw 'No arguments passed';

		switch (element) {
			case 'set':
				return processSet(args);
			case 'echo':
				return processEcho(args);
			case 'include':
				return processInclude(args);
			// FIXME: handle if, else, endif, config, fsize, flastmod, printenv
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

setBaseVars();
var processed = processShtml(getContents(window.location.href));

var newDoc = document.open('text/html', 'replace');
newDoc.write(processed);
newDoc.close();
