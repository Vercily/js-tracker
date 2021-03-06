/* import libs */
const escodegen = require('escodegen')
const arity = require('util-arity')

/* import structures */
const Callee = require('./structures/Callee')

/* import operators */
const binaryOperators = require('./operators/binaryOperators')
const updateOperators = require('./operators/updateOperators')
const unaryOperators = require('./operators/unaryOperators')

/* for variables init */
const Flag = require('./structures/Flag')
const Collection = require('./structures/Collection')
const FlowState = require('./structures/FlowState')
const ClosureStack = require('./structures/ClosureStack')
const checkerDispatcher = require('./dispatchers/checkerDispatcher')

class EsprimaParser {
  constructor(context) {
    /* import libs */
    this.escodegen = escodegen
    this.arity = arity

    /* import structures */
    this.Callee = Callee
    this.FlowState = FlowState
    this.Collection = Collection

    /* import operators */
    this.binaryOperators = binaryOperators
    this.updateOperators = updateOperators
    this.unaryOperators = this.initUnaryOperators(unaryOperators)
    this.logicalOperators = this.initLogicalOperators()
    this.assignmentOperators = this.initAssignmentOperators()

    /* variables */
    context.this = context
    this.context = context
    this.scriptUrl = null

    this.checkFlag = false // track only high level api

    this.collection = new Collection()
    this.flowState = new FlowState()
    this.closureStack = new ClosureStack(context)
    this.checkerDispatcher = checkerDispatcher
  }

  initUnaryOperators(importedUnaryOperators = {}) {
    return Object.assign({}, importedUnaryOperators, {
      'delete': ({caller, callee}) => {
        const target = (caller === undefined) ? this.context : caller

        return delete target[callee]
      }
    })
  }

  initLogicalOperators() {
    return {
      '||': (left, right) => {
        return this.parseNode(left) || this.parseNode(right)
      },
      '&&': (left, right) => {
        return this.parseNode(left) && this.parseNode(right)
      }
    }
  }

  initAssignmentOperators() {
    return {
      '=': (exp, value) => {
        const success = this.setCheckFlag(exp)

        this.handleAssign(exp, value)
        this.resetCheckFlag(success)

        return value
      }
    }
  }

  handleAssign({caller, callee}, value) {
    if (caller === undefined) {
      this.updateVariables(callee, value)
    } else {
      caller[callee] = value
    }
  }

  /*************************/
  /*        Parsers        */
  /*************************/

  parseAst(root, scriptUrl) {
    this.setScriptUrl(scriptUrl)
    this.parseNode(root)
  }

  setScriptUrl(scriptUrl) {
    this.scriptUrl = scriptUrl
  }

  parseNode(node, options = {}) {
    let result

    if (node) {
      result = this[node.type](node, options)
      this.handleStatementLabelState(options.label)
    }
    return result
  }

  handleStatementLabelState(label) {
    if (this.isStatementLabelNeededToUnset(label)) {
      // @NOTE:
      // continue state only exists in loop, and loop statements already handle it
      // return state only reset when function return, thus return should never unset here
      this.flowState.unsetBreak()
      this.flowState.unsetLabel()
    }
  }

  isStatementLabelNeededToUnset(label) {
    // most of the time, flowState.label is null
    return (
      !this.flowState.isNullLabel() &&
      this.flowState.isLabelMatched(label)
    )
  }

  Identifier(identifier) {
    if (identifier.name === 'null') {
      return null
    } else if (identifier.name === 'undefined') {
      return undefined
    }
    return this.closureStack.get(identifier.name)
  }

  Literal(literal) {
    if (literal.regex) {
      return new RegExp(literal.regex.pattern, literal.regex.flags)
    }
    return literal.value
  }

  Program(program) {
    const body = program.body

    this.handleHoisting(body)
    this.parseStatements(body)
  }

  handleHoisting(statements) {
    const hoistings = this.searchHoistings(statements)

    this.setHoistings(hoistings)
  }

  searchHoistings(statements) {
    const hoistings = []

    for (const statement of statements) {
      if (statement) {
        hoistings.push(...this.parseHoisting(statement))
      }
    }
    return hoistings
  }

  parseHoisting(statement) {
    switch (statement.type) {
      case 'FunctionDeclaration':
        return [].concat(
          this.getNameFromPattern(statement.id)
        )

      case 'VariableDeclaration':
        return statement.kind === 'var' ?
          this.getNameFromVariableDeclaration(statement) : []

      default:
        return this.searchSubHoistings(statement)
    }
  }

  getNameFromPattern(pattern) {
    // @TODO: es6: ObjectPattern / ArrayPattern
    switch (pattern.type) {
      case 'Identifier':
        return pattern.name

      default:
        return undefined
    }
  }

  getNameFromVariableDeclaration(variableDeclaration) {
    const variables = []

    for (const declaration of variableDeclaration.declarations) {
      variables.push(this.getNameFromPattern(declaration.id))
    }
    return variables
  }

  searchSubHoistings(statement) {
    const statements = this.filterSubStatements(statement)

    return this.searchHoistings(statements)
  }

  filterSubStatements(statement) {
    switch (statement.type) {
      case 'BlockStatement':
        return statement.body

      case 'IfStatement':
        return [].concat(statement.consequent, statement.alternate)

      case 'SwitchStatement':
        return statement.cases.reduce((pre, cur) => {
          return pre.concat(cur.consequent)
        }, [])

      case 'TryStatement':
        const handler = statement.handler ?
          statement.handler.body : statement.handler

        return [].concat(statement.block, handler, statement.finalizer)

      case 'ForStatement':
        return [].concat(statement.init, statement.body)

      case 'ForInStatement':
        return [].concat(statement.left, statement.body)

      case 'WhileStatement':
      case 'DoWhileStatement':
        return [].concat(statement.body)

      default:
        return []
    }
  }

  setHoistings(hoistings) {
    for (const hoisting of hoistings) {
      this.setVariables(hoisting, undefined)
    }
  }

  setVariables(variables, values) {
    // @TODO: es6: function closure / block closure
    // @TODO: es6: ObjectPattern / ArrayPattern
    this.closureStack.set(variables, values)
  }

  parseStatements(statements) {
    // after init hoisting var, var is never a hoisting statement
    const nonHoistingStatements =
      this.parseHoistingStatements(statements)

    return this.parseNonHoistingStatements(nonHoistingStatements)
  }

  parseHoistingStatements(statements) {
    const nonHoistingStatements = []

    for (const statement of statements) {
      if (!this.isHoistingStatement(statement)) {
        nonHoistingStatements.push(statement)
      }
    }
    return nonHoistingStatements
  }

  isHoistingStatement(statement) {
    if (statement.type === 'FunctionDeclaration') {
      this.parseNode(statement)
      return true
    }
    return false
  }

  parseNonHoistingStatements(statements) {
    let result

    for (const statement of statements) {
      result = this.parseNode(statement)

      if (this.flowState.isEitherState()) {
        break
      }
    }
    return result
  }

  /*************************/
  /*       Statements      */
  /*************************/

  ExpressionStatement(expressionStatement) {
    this.parseNode(expressionStatement.expression)
  }

  BlockStatement(blockStatement) {
    // @TODO: es6: create and push new block scope to closureStack
    const result = this.parseStatements(blockStatement.body)
    // @TODO: es6: pop block scope from closureStack
    return result
  }

  EmptyStatement() {
  }

  /*************************/
  /*      Control Flow     */
  /*************************/

  ReturnStatement(returnStatement) {
    // should call parseReturnArgument before set 'return' status,
    // because return argument might be another function which has return value,
    // after that function finishing, it will unset all return status, including status set here
    const result = this.parseReturnArgument(returnStatement.argument)

    this.flowState.set(FlowState.RETURN)

    return result
  }

  parseReturnArgument(argument) {
    return argument ? this.parseNode(argument) : undefined
  }

  LabeledStatement(labeledStatement) {
    const label =
      this.getNameFromPattern(labeledStatement.label)

    return this.parseNode(labeledStatement.body, {label})
  }

  BreakStatement(breakStatement) {
    this.flowState.setBreak()
    this.setFlowStateLabel(breakStatement.label)
  }

  setFlowStateLabel(labelNode) {
    if (labelNode) {
      const label = this.getNameFromPattern(labelNode)

      this.flowState.setLabel(label)
    }
  }

  ContinueStatement(continueStatement) {
    this.flowState.setContinue()
    this.setFlowStateLabel(continueStatement.label)
  }

  /*************************/
  /*        Choice         */
  /*************************/

  IfStatement(ifStatement) {
    const testPass = this.parseNode(ifStatement.test)

    return testPass ?
      this.parseNode(ifStatement.consequent) :
      this.parseNode(ifStatement.alternate)
  }

  SwitchStatement(switchStatement) {
    const discriminant = this.parseNode(switchStatement.discriminant)
    const result = this.parseSwitchCases(switchStatement.cases, discriminant)

    this.flowState.unset(FlowState.BREAK)

    return result
  }

  parseSwitchCases(switchCases, discriminant) {
    let result

    for (const [matchedIndex, switchCase] of switchCases.entries()) {
      const matched = this.isCaseMatched(switchCase.test, discriminant)

      if (matched) {
        result = this.parseMatchedCase(switchCases, matchedIndex)
        break
      }
    }
    return result
  }

  isCaseMatched(testExpression, discriminant) {
    if (testExpression === null) {
      // default case
      return true
    }
    return (this.parseNode(testExpression) === discriminant)
  }

  parseMatchedCase(switchCases, matchedIndex) {
    // matched case might be empty and combined together with consequent cases,
    // start parsing statements from matchedIndex,
    // if the case has no break / return statement (including empty case),
    // it should keep parsing consequent cases until any break / return or end of default case
    return this.parseStatements(switchCases.slice(matchedIndex))
  }

  SwitchCase(switchCase) {
    return this.parseStatements(switchCase.consequent)
  }

  /*************************/
  /*       Exceptions      */
  /*************************/

  ThrowStatement(throwStatement) {
    const error = this.parseNode(throwStatement.argument)

    throw error
  }

  TryStatement(tryStatement) {
    const result = {}

    try {
      Object.assign(result, this.handleExceptionBlock(tryStatement.block))
    } catch (e) {
      Object.assign(result, this.handleCatchClause(tryStatement.handler, e))
    } finally {
      Object.assign(result, this.handleExceptionBlock(tryStatement.finalizer))
    }
    return this.handleExceptionResult(result)
  }

  handleExceptionBlock(block) {
    const value = this.parseNode(block)

    return this.getExceptionBlockResult(value)
  }

  getExceptionBlockResult(value) {
    if (this.flowState.isReturnState()) {
      this.flowState.unset(this.FlowState.RETURN)
      return {value}
    }
    return {}
  }

  handleCatchClause(catchClause, error) {
    if (catchClause) {
      try {
        return this.parseCatchClause(catchClause, error)
      } catch (e) {
        return {error: e}
      }
    }
    return {error}
  }

  parseCatchClause(catchClause, error) {
    this.setCatchError(catchClause.param, error)

    return this.handleExceptionBlock(catchClause.body)
  }

  setCatchError(param, error) {
    // @TODO: es6: create new block closure
    const variables = this.getNameFromPattern(param)

    this.setVariables(variables, error)
  }

  handleExceptionResult(result) {
    if (result.hasOwnProperty('value')) {
      this.flowState.set(this.FlowState.RETURN)
      return result.value
    } else if (result.hasOwnProperty('error')) {
      throw result.error
    }
    return undefined
  }

  /*************************/
  /*         Loops         */
  /*************************/

  WhileStatement(whileStatement, {label} = {}) {
    let result

    while (this.parseNode(whileStatement.test)) {
      result = this.parseNode(whileStatement.body)

      if (this.isLoopNeededToBreak(label)) {
        break
      }
    }
    return result
  }

  isLoopNeededToBreak(label) {
    if (this.flowState.isReturnState()) {
      return true
    }

    if (this.flowState.isBreakState()) {
      return this.handleLoopBreakState(label)
    }

    if (this.flowState.isContinueState()) {
      return this.handleLoopContinueState(label)
    }
    return false
  }

  handleLoopBreakState(label) {
    if (this.isLoopStateNeededToUnset(label)) {
      this.flowState.unsetBreak()
      // label here could only be null or matched
      // it should only unset matched label,
      // but unset null label is never mind.
      this.flowState.unsetLabel()
    }
    return true
  }

  isLoopStateNeededToUnset(label) {
    return (
      this.flowState.isNullLabel() ||
      this.flowState.isLabelMatched(label)
    )
  }

  handleLoopContinueState(label) {
    if (this.isLoopStateNeededToUnset(label)) {
      this.flowState.unsetContinue()
      // label here could only be null or matched
      // it should only unset matched label,
      // but unset null label is never mind.
      this.flowState.unsetLabel()

      return false
    }
    return true
  }

  DoWhileStatement(doWhileStatement, {label} = {}) {
    let result = this.parseNode(doWhileStatement.body)

    if (!this.isLoopNeededToBreak(label)) {
      result = this.WhileStatement(doWhileStatement)
    }
    return result
  }

  ForStatement(forStatement, {label} = {}) {
    // @TODO: es6: block closure
    let result

    for (
      this.parseNode(forStatement.init);
      this.parseNode(forStatement.test);
      this.parseNode(forStatement.update)
    ) {
      result = this.parseNode(forStatement.body)

      if (this.isLoopNeededToBreak(label)) {
        break
      }
    }
    return result
  }

  ForInStatement(forInStatement, {label} = {}) {
    // @TODO: es6: block closure
    const left = this.parseIterator(forInStatement.left)
    const right = this.parseNode(forInStatement.right)
    let result

    for (const key in right) {
      this.updateVariables(left, key)

      result = this.parseNode(forInStatement.body)

      if (this.isLoopNeededToBreak(label)) {
        break
      }
    }
    return result
  }

  parseIterator(node) {
    switch (node.type) {
      case 'VariableDeclaration':
        // @NOTE: initialize iterator
        // @CASE: for (var key in object) { ... }
        this.parseNode(node)
        return this.getNameFromVariableDeclaration(node)[0]

      default:
        return this.getNameFromPattern(node)
    }
  }

  updateVariables(variables, values) {
    // @TODO: es6: ObjectPattern / ArrayPattern
    this.closureStack.update(variables, values)
  }

  /*************************/
  /*      Declarations     */
  /*************************/

  FunctionDeclaration(functionDeclaration) {
    const variable = this.getNameFromPattern(functionDeclaration.id) // id is Identifier only
    const functionAgent = this.createFunctionAgent(functionDeclaration)

    this.setVariables(variable, functionAgent)
  }

  createFunctionAgent(functionExpression) {
    const functionAgentData =
      this.parseFunctionExpression(functionExpression)
    const functionAgent =
      this.wrapWithFunction(functionAgentData)
    // @NOTE: arity simulate function.length
    // @CASE: function (a, b, c).length should be 3 not 0
    return this.arity(
      functionAgentData.params.length,
      functionAgent
    )
  }

  parseFunctionExpression(functionExpression) {
    const functionEnvironment = this.getEnvironment(this)
    const functionInfo = this.parseFunctionInfo(functionExpression)

    return Object.assign({}, functionEnvironment, functionInfo)
  }

  getEnvironment(context) {
    return {
      scriptUrl: context.scriptUrl,
      closureStack: context.closureStack.getClone()
    }
  }

  parseFunctionInfo(functionExpression) {
    return {
      body: functionExpression.body,
      params: this.parseFunctionParams(functionExpression.params),
      hoistings: this.searchHoistings([functionExpression.body])
    }
  }

  parseFunctionParams(params) {
    // @TODO: a way to identify rest args
    return params.map((param) => {
      return this.getNameFromPattern(param)
    })
  }

  wrapWithFunction(functionAgentData) {
    const self = this

    return function (...calledArguments) {
      return self.parseFunctionAgentData(functionAgentData, {
        this: this,
        arguments: arguments
      }, calledArguments)
    }
  }

  parseFunctionAgentData(functionAgentData, builtInArguments, calledArguments) {
    // environment refers to an object containing scriptUrl and closureStack
    const envGlobal = this.getEnvironment(this)
    const envFunction = this.getEnvironment(functionAgentData)
    let result

    this.setEnvironment(this, envFunction)

    this.closureStack.createClosure()

    this.setHoistings(functionAgentData.hoistings)
    this.setBuiltInArguments(builtInArguments)
    this.setCalledArguments(functionAgentData.params, calledArguments)

    try {
      result = this.parseNode(functionAgentData.body)
    } finally {
      // @NOTE: should reset environment when error thrown while parsing function body
      this.setEnvironment(this, envGlobal)
    }
    this.flowState.unset(FlowState.RETURN)

    return result
  }

  setEnvironment(context, environment) {
    context.scriptUrl = environment.scriptUrl
    context.closureStack = environment.closureStack
  }

  setBuiltInArguments(builtInArguments) {
    this.setVariables('this', builtInArguments.this || this.context)
    this.setVariables('arguments', builtInArguments.arguments)
  }

  setCalledArguments(params, values) {
    for (const index of params.keys()) {
      this.setVariables(params[index], values[index])
    }
  }

  VariableDeclaration(variableDeclaration) {
    // @TODO: var -> function closure
    // @TODO: es6: let, const -> block closure
    const kind = variableDeclaration.kind

    variableDeclaration.declarations.forEach(
      (variableDeclarator) => {
        this.VariableDeclarator(variableDeclarator, kind)
      }
    )
  }

  VariableDeclarator(variableDeclarator, kind) {
    if (this.isVariableNeededToSet(kind, variableDeclarator.init)) {
      this.parseVariableDeclarator(variableDeclarator)
    }
  }

  isVariableNeededToSet(kind, init) {
    return !(kind === 'var' && init === null)
  }

  parseVariableDeclarator(variableDeclarator) {
    // @TODO: es6: ObjectPattern / ArrayPattern
    const variables = this.getNameFromPattern(variableDeclarator.id)
    const values = this.parseNode(variableDeclarator.init)

    this.setVariables(variables, values)
  }

  /*************************/
  /*      Expressions      */
  /*************************/

  ThisExpression() {
    return this.closureStack.get('this')
  }

  ArrayExpression(arrayExpression) {
    const result = []

    arrayExpression.elements.forEach((node, index) => {
      result.push(this.parseNode(node))
      // @NOTE: should delete null node
      // @CASE: [1, , 2] != [1, undefined, 2]
      if (!node) {
        delete result[index]
      }
    })
    return result
  }

  ObjectExpression(objectExpression) {
    const result = {}

    objectExpression.properties.forEach((node) => {
      const {key, value} = this.parseNode(node)

      result[key] = value
    })
    return result
  }

  Property(property) {
    return {
      key: this.getPropertyKey(
        property.key,
        property.computed
      ),
      value: this.parseNode(property.value)
    }
  }

  getPropertyKey(key, computed) {
    if (computed) {
      return this.parseNode(key)
    }
    return (key.name || key.value)
  }

  FunctionExpression(functionExpression) {
    const functionAgentData =
      this.parseFunctionExpression(functionExpression)
    const functionAgent =
      this.wrapWithFunction(functionAgentData)
    const functionArity = this.arity(
      functionAgentData.params.length,
      functionAgent
    )
    // @NOTE: should keep reference to its functionAgentData.closureStack given non-null id
    // @CASE: (function test() {console.log(test)})(), should not log undefined
    if (functionExpression.id) {
      this.setFunctionExpressionTo(
        functionAgentData,
        functionExpression.id,
        functionArity
      )
    }
    return functionArity
  }

  setFunctionExpressionTo(functionAgentData, id, functionAgent) {
    const variable = this.getNameFromPattern(id)

    functionAgentData.closureStack.createClosure()
    functionAgentData.closureStack.set(variable, functionAgent)
  }

  UnaryExpression(unaryExpression) {
    const argument = this.parseUnaryArgument(
      unaryExpression.argument,
      unaryExpression.operator
    )
    const operation = this.unaryOperators[unaryExpression.operator]

    return operation(argument)
  }

  parseUnaryArgument(argument, operator) {
    switch (operator) {
      case 'delete':
        return this.getRefExp(argument)

      default:
        return this.parseNode(argument)
    }
  }

  getRefExp(expression) {
    switch (expression.type) {
      case 'MemberExpression':
        return this.getMemberExp(expression)

      default:
        return this.getPatternExp(expression)
    }
  }

  getPatternExp(pattern) {
    return {
      caller: undefined,
      callee: this.getNameFromPattern(pattern)
    }
  }

  UpdateExpression(updateExpression) {
    // @NOTE: '++' != '+='
    // @CASE: "0"++ -> 1, "0" += 1 -> "01"
    const origin = this.parseNode(updateExpression.argument)
    const update = this.updateOperators[updateExpression.operator](origin)

    this.setUpdateValue(updateExpression.argument, update)

    return updateExpression.prefix ? update : origin
  }

  setUpdateValue(argument, update) {
    const exp = this.getRefExp(argument)
    const operation = this.assignmentOperators['=']

    operation(exp, update)
  }

  BinaryExpression(binaryExpression) {
    const left = this.parseNode(binaryExpression.left)
    const right = this.parseNode(binaryExpression.right)
    const operation = this.binaryOperators[binaryExpression.operator]

    return operation(left, right)
  }

  AssignmentExpression(assignmentExpression) {
    const exp = this.getRefExp(assignmentExpression.left) // {callee, caller}
    const value = this.getAssignValue(assignmentExpression)
    const operation = this.assignmentOperators['=']

    exp.info = this.getExpInfo(assignmentExpression)

    return operation(exp, value)
  }

  getAssignValue(assignmentExpression) {
    const binaryExpression =
      this.transAssignmentToBinary(assignmentExpression)

    return binaryExpression.operator ?
      this.BinaryExpression(binaryExpression) :
      this.parseNode(binaryExpression.right)
  }

  transAssignmentToBinary(assignmentExpression) {
    return {
      type: 'BinaryExpression',
      operator: assignmentExpression.operator.replace(/\=$/, ''),
      left: assignmentExpression.left,
      right: assignmentExpression.right
    }
  }

  LogicalExpression(logicalExpression) {
    const operation = this.logicalOperators[logicalExpression.operator]

    return operation(logicalExpression.left, logicalExpression.right)
  }

  MemberExpression(memberExpression) {
    const exp = this.getMemberExp(memberExpression) // {caller, callee}

    return this.parseMemberExp(exp)
  }

  getMemberExp(memberExpression) {
    return {
      caller: this.parseNode(memberExpression.object),
      callee: this.getPropertyKey(
        memberExpression.property,
        memberExpression.computed
      )
    }
  }

  parseMemberExp(exp) {
    const result = this.execute(exp)
    // definition of valid Style / DOMTokenList here is:
    // (1) result have no parent property
    // (2) result is CSSStyleDeclaration / DOMTokenList instance
    if (this.isValidStyleOrDOMTokenList(result)) {
      result.parent = exp.caller
    }
    return result
  }

  execute(exp) {
    // try {
      return this.executeExp(exp)
    // } catch (e) {
      // console.log(e);
      // console.log(exp);
      // return undefined
    // }
  }

  executeExp(exp) {
    return (exp.callee instanceof this.Callee) ?
      this.executeCall(exp) : this.executeMember(exp)
  }

  executeCall({caller, callee}) {
    // a function had been bound can not change context by bind, call and apply
    // a function call or apply with non-object context would be ignored
    const calledMethod = this.getCalledMethod({caller, callee})

    return calledMethod.apply(caller, callee.arguments)
  }

  getCalledMethod({caller, callee}) {
    return (caller === undefined) ? callee.method : caller[callee.method]
  }

  executeMember({caller, callee}) {
    return caller[callee]
  }

  isValidStyleOrDOMTokenList(object) {
    return (
      this.hasNoParent(object) &&
      this.isStyleOrDOMTokenList(object)
    )
  }

  hasNoParent(object) {
    return (object instanceof Object) && (!object.hasOwnProperty('parent'))
  }

  isStyleOrDOMTokenList(object) {
    return this.isStyle(object) || this.isDOMTokenList(object)
  }

  isStyle(object) {
    return (object instanceof this.context.CSSStyleDeclaration)
  }

  isDOMTokenList(object) {
    return (object instanceof this.context.DOMTokenList)
  }

  ConditionalExpression(conditionalExpression) {
    const test = this.parseNode(conditionalExpression.test)

    return test ?
      this.parseNode(conditionalExpression.consequent) :
      this.parseNode(conditionalExpression.alternate)
  }

  CallExpression(callExpression) {
    const exp = this.getCallExp(callExpression) // {caller, callee}

    exp.info = this.getExpInfo(callExpression)

    return this.parseCallExp(exp)
  }

  getCallExp(callExpression) {
    const exp = this.parseCallee(callExpression.callee)
    const calleeArguments = this.parseArguments(callExpression.arguments)

    exp.callee.addArguments(calleeArguments)

    return exp
  }

  parseCallee(callee) {
    const exp = this.getCalleeExp(callee)

    return {
      caller: exp.caller,
      callee: this.createCallee(exp.callee)
    }
  }

  getCalleeExp(callee) {
    switch (callee.type) {
      case 'MemberExpression':
        return this.getMemberExp(callee)

      default:
        return this.getOtherExp(callee)
    }
  }

  getOtherExp(expression) {
    return {
      caller: undefined,
      callee: this.parseNode(expression)
    }
  }

  createCallee(method) {
    return new (this.Callee)(method)
  }

  parseArguments(calledArguments) {
    return calledArguments.map((argument) => {
      return this.parseNode(argument)
    })
  }

  getExpInfo(expression) {
    return {
      loc: expression.loc,
      code: this.escodegen.generate(expression),
      scriptUrl: this.scriptUrl
    }
  }

  parseCallExp(exp) {
    // exp: {caller, callee, info}
    const success = this.setCheckFlag(exp)
    const result = this.execute(exp)

    this.resetCheckFlag(success)

    return result
  }

  setCheckFlag(exp) {
    if (!this.checkFlag && exp.caller) {
      const status = this.checkerDispatcher.dispatch({
        context: this.context,
        caller: exp.caller,
        callee: exp.callee
      })
      return this.tryToSetCheckFlag(exp, status)
    }
    return false
  }

  tryToSetCheckFlag(exp, status) {
    if (status) {
      this.checkFlag = true
      this.addInfoToCollection(exp, status)
    }
    return !!status
  }

  addInfoToCollection(exp, status) {
    const elements = this.getTargetElements(exp.caller, status)

    this.collection.addInfoToElements({
      elements,
      type: status.type,
      info: exp.info
    })
  }

  getTargetElements(caller, status) {
    const object = this.getTargetObject(caller, status)
    const elements = this.isJquery(object) ? object.get() : object
    // @NOTE: target could be an array for future use
    return [].concat(elements)
  }

  getTargetObject(caller, status) {
    if (status.hasOwnProperty('target')) {
      return status.target
    } else if (this.isStyleOrDOMTokenList(caller)) {
      return caller.parent
    } else if (this.isAttr(caller)) {
      return caller.ownerElement
    }
    return caller
  }

  isAttr(object) {
    return (object instanceof this.context.Attr)
  }

  isJquery(object) {
    const jQuery = this.context.jQuery

    return !!jQuery && object instanceof jQuery
  }

  resetCheckFlag(success) {
    if (success) {
      this.checkFlag = false
    }
  }

  NewExpression(newExpression) {
    const CalledConstructor = this.parseNode(newExpression.callee)
    const calledArguments = this.parseArguments(newExpression.arguments)

    return new CalledConstructor(...calledArguments)
  }

  SequenceExpression(sequenceExpression) {
    let result

    sequenceExpression.expressions.forEach((expression) => {
      // all here are expressions, no need to check flow control status
      result = this.parseNode(expression)
    })
    return result
  }
}
module.exports = EsprimaParser
