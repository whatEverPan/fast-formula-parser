const TextFunctions = require('../formulas/functions/text');
const MathFunctions = require('../formulas/functions/math');
const TrigFunctions = require('../formulas/functions/trigonometry');
const LogicalFunctions = require('../formulas/functions/logical');
const EngFunctions = require('../formulas/functions/engineering');
const ReferenceFunctions = require('../formulas/functions/reference');
const InformationFunctions = require('../formulas/functions/information');
const StatisticalFunctions = require('../formulas/functions/statistical');
const DateFunctions = require('../formulas/functions/date');
const FormulaError = require('../formulas/error');
const {FormulaHelpers} = require('../formulas/helpers');
const {Parser, allTokens} = require('./parsing');
const lexer = require('./lexing');
const Utils = require('./utils');

/**
 * A Excel Formula Parser & Evaluator
 */
class FormulaParser {

    /**
     * @param {{functions: {}, functionsNeedContext: {}, onVariable: function, onCell: function, onRange: function}} [config]
     * @param isTest - is in testing environment
     */
    constructor(config, isTest = false) {
        this.logs = [];
        this.isTest = isTest;
        this.utils = new Utils(this);
        config = Object.assign({
            functions: {},
            functionsNeedContext: {},
            onVariable: () => null,
            onCell: () => 0,
            onRange: () => [[0]],
        }, config);

        this.onVariable = config.onVariable;
        this.functions = Object.assign({}, DateFunctions, StatisticalFunctions, InformationFunctions, ReferenceFunctions,
            EngFunctions, LogicalFunctions, TextFunctions, MathFunctions, TrigFunctions, config.functions, config.functionsNeedContext);
        this.onRange = config.onRange;
        this.onCell = config.onCell;

        // functions treat null as 0, other functions treats null as ""
        this.funsNullAs0 = Object.keys(MathFunctions)
            .concat(Object.keys(TrigFunctions))
            .concat(Object.keys(LogicalFunctions))
            .concat(Object.keys(EngFunctions))
            .concat(Object.keys(ReferenceFunctions))
            .concat(Object.keys(StatisticalFunctions))
            .concat(Object.keys(DateFunctions));

        // functions need context and don't need to retrieve references
        this.funsNeedContextAndNoDataRetrieve = ['ROW', 'ROWS', 'COLUMN', 'COLUMNS', 'SUMIF', 'INDEX', 'AVERAGEIF'];
        this.funsNeedContext = Object.keys(config.functionsNeedContext);
        this.funsPreserveRef = Object.keys(InformationFunctions);

        this.parser = new Parser(this, this.utils);
    }

    /**
     * Get all lexing token names. Webpack needs this.
     * @return {Array.<string>} - All token names that should not be minimized.
     */
    static get allTokens() {
        return allTokens;
    }

    /**
     * Get value from the cell reference
     * @param ref
     * @return {*}
     */
    getCell(ref) {
        // console.log('get cell', JSON.stringify(ref));
        if (ref.sheet == null)
            ref.sheet = this.position ? this.position.sheet : undefined;
        return this.onCell(ref);
    }

    /**
     * Get values from the range reference.
     * @param ref
     * @return {*}
     */
    getRange(ref) {
        // console.log('get range', JSON.stringify(ref));
        if (ref.sheet == null)
            ref.sheet = this.position ? this.position.sheet : undefined;
        return this.onRange(ref)
    }

    /**
     * TODO:
     * Get references or values from a user defined variable.
     * @param name
     * @return {*}
     */
    getVariable(name) {
        // console.log('get variable', name);
        const res = {ref: this.onVariable(name, this.position.sheet)};
        if (res.ref == null)
            return FormulaError.NAME;
        return res;
    }

    /**
     * Retrieve values from the given reference.
     * @param valueOrRef
     * @return {*}
     */
    retrieveRef(valueOrRef) {
        if (FormulaHelpers.isRangeRef(valueOrRef)) {
            return this.getRange(valueOrRef.ref);
        }
        if (FormulaHelpers.isCellRef(valueOrRef)) {
            return this.getCell(valueOrRef.ref)
        }
        return valueOrRef;
    }

    /**
     * The functions that can return a reference instead of a value as normal functions.
     * Note: Not all functions from "Lookup and reference" category can return a reference.
     * {@link https://support.office.com/en-ie/article/lookup-and-reference-functions-reference-8aa21a3a-b56a-4055-8257-3ec89df2b23e}
     * @param name - Reference function name.
     * @param args - Arguments that pass to the function.
     */
    callRefFunction(name, args) {
        name = name.toUpperCase();
        if (this.functions[name]) {
            let res;
            try {
                res = (this.functions[name](this, ...args));
            } catch (e) {
                // allow functions throw FormulaError, this make functions easier to implement!
                if (e instanceof FormulaError) {
                    return e;
                } else {
                    throw e;
                }
            }
            if (res === undefined) {
                return {value: 0, ref: {}};
            }
            return FormulaHelpers.checkFunctionResult(res);
        } else {
            if (!this.logs.includes(name)) this.logs.push(name);
            // console.log(`Function ${name} is not implemented`);
            return {value: 0, ref: {}};
        }
    }

    /**
     * Call an excel function.
     * @param name - Function name.
     * @param args - Arguments that pass to the function.
     * @return {*}
     */
    callFunction(name, args) {
        if (name.indexOf('_xlfn.') === 0)
            name = name.slice(6);
        name = name.toUpperCase();
        // if one arg is null, it means 0 or "" depends on the function it calls
        const nullValue = this.funsNullAs0.includes(name) ? 0 : '';

        if (!this.funsNeedContextAndNoDataRetrieve.includes(name)) {
            // retrieve reference
            args = args.map(arg => {
                if (arg === null)
                    return {value: nullValue, isArray: false, omitted: true};
                const res = this.utils.extractRefValue(arg);

                if (this.funsPreserveRef.includes(name)) {
                    return {value: res.val, isArray: res.isArray, ref: arg.ref};
                }
                return {
                    value: res.val,
                    isArray: res.isArray,
                    isRangeRef: !!FormulaHelpers.isRangeRef(arg),
                    isCellRef: !!FormulaHelpers.isCellRef(arg)
                };
            });
        }
        // console.log('callFunction', name, args)

        if (this.functions[name]) {
            let res;
            try {
                if (!this.funsNeedContextAndNoDataRetrieve.includes(name) || this.funsNeedContext.includes(name))
                    res = (this.functions[name](...args));
                else
                    res = (this.functions[name](this, ...args));
            } catch (e) {
                // allow functions throw FormulaError, this make functions easier to implement!
                if (e instanceof FormulaError) {
                    return e;
                } else {
                    throw e;
                }
            }
            if (res === undefined) {
                // console.log(`Function ${name} may be not implemented.`);
                if (this.isTest) {
                    if (!this.logs.includes(name)) this.logs.push(name);
                    return {value: 0, ref: {}};
                }
                throw FormulaError.NOT_IMPLEMENTED(name);
            }
            return FormulaHelpers.checkFunctionResult(res);
        } else {

            // console.log(`Function ${name} is not implemented`);
            if (this.isTest) {
                if (!this.logs.includes(name)) this.logs.push(name);
                return {value: 0, ref: {}};
            }
            throw FormulaError.NOT_IMPLEMENTED(name);
        }
    }

    /**
     * Return currently supported functions.
     * @return {this}
     */
    supportedFunctions() {
        const supported = [];
        const functions = Object.keys(this.functions);
        functions.forEach(fun => {
            let res;
            try {
                res = this.functions[fun](0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
                if (res === undefined) return;
                supported.push(fun);
            } catch (e) {
                if (e instanceof FormulaError || e instanceof TypeError)
                    supported.push(fun);
                // else
                //     console.log(e)
            }
        });
        return supported.sort();
    }

    /**
     * Check and return the appropriate formula result.
     * @param result
     * @param {boolean} [allowReturnArray] - If the formula can return an array
     * @return {*}
     */
    checkFormulaResult(result, allowReturnArray = false) {
        const type = typeof result;
        // number
        if (type === 'number') {
            if (isNaN(result)) {
                return FormulaError.VALUE;
            } else if (!isFinite(result)) {
                return FormulaError.NUM;
            }
            result += 0; // make -0 to 0
        } else if (type === 'object') {
            if (result instanceof FormulaError)
                return result;
            if (allowReturnArray) {
                if (result.ref) {
                    result = this.retrieveRef(result);
                }
                if (Array.isArray(result)) {
                    return result;
                } else {
                    return FormulaError.VALUE;
                }

            } else {
                if (result.ref && result.ref.row && !result.ref.from) {
                    // single cell reference
                    result = this.retrieveRef(result);
                } else if (result.ref && result.ref.from && result.ref.from.col === result.ref.to.col) {
                    // single Column reference
                    result = this.retrieveRef({
                        ref: {
                            row: result.ref.from.row, col: result.ref.from.col
                        }
                    });
                } else if (Array.isArray(result)) {
                    result = result[0][0]
                } else {
                    // array, range reference, union collections
                    return FormulaError.VALUE;
                }
            }
        }
        return result;
    }

    /**
     * Parse an excel formula.
     * @param inputText
     * @param {{row: number, col: number}} [position] - The position of the parsed formula
     *              e.g. {row: 1, col: 1}
     * @param {boolean} [allowReturnArray] - If the formula can return an array. Useful when parsing array formulas,
     *                                      or data validation formulas.
     * @returns {*}
     */
    parse(inputText, position, allowReturnArray = false) {
        if (inputText.length === 0) throw Error('Input must not be empty.');
        this.position = position;
        const lexResult = lexer.lex(inputText);
        this.parser.input = lexResult.tokens;
        let res;
        try {
            res = this.parser.formulaWithBinaryOp();
            res = this.checkFormulaResult(res, allowReturnArray);
            if (res instanceof FormulaError) {
                return res;
            }
        } catch (e) {
            // console.log(e);
            throw e;
        }
        if (this.parser.errors.length > 0) {
            const error = this.parser.errors[0];
            throw this.utils.formatChevrotainError(error);
        }
        return res;
    }
}

module.exports = {
    FormulaParser,
    FormulaHelpers,
};
