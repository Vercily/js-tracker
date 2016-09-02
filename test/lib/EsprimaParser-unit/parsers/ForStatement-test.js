// spec: https://github.com/estree/estree/blob/master/spec.md#forstatement

describe('ForStatement tests', () => {
  const resultStub = 'resultFromParseLoopBody'
  const parseLoopBodyStub = {}
  const setTestResults = (results) => {
    const getTestResults = createResultsGenerator(results)

    for (const index of results.keys()) {
      esprimaParser.parseNode
        .withArgs(forStatement.test)
          .onCall(index).returns(getTestResults())
    }
  }
  let forStatement, FlowState

  before(() => {
    FlowState = require('../../../../lib/EsprimaParser/structures/FlowState')
  })

  beforeEach(() => {
    forStatement = createAstNode('ForStatement', {
      init: createAstNode('ExpressionInit'),
      test: createAstNode('ExpressionTest'),
      update: createAstNode('ExpressionUpdate'),
      body: createAstNode('Statement')
    })

    sandbox.stub(esprimaParser, 'parseNode')
    sandbox.stub(esprimaParser, 'parseLoopBody')
      .returns(parseLoopBodyStub)
  })

  it('should call parseNode with init for once', () => {
    esprimaParser.ForStatement(forStatement)

    expect(
      esprimaParser.parseNode
        .withArgs(forStatement.init).calledOnce
    ).to.be.true
  })

  it('should call parseNode with test until test fails', () => {
    setTestResults([true, true, false, true, true])

    esprimaParser.ForStatement(forStatement)

    expect(
      esprimaParser.parseNode
        .withArgs(forStatement.test).calledThrice
    ).to.be.true
  })

  it('should call parseLoopBody with body each loop', () => {
    setTestResults([true, true, false])

    esprimaParser.ForStatement(forStatement)

    expect(
      esprimaParser.parseLoopBody
        .withArgs(forStatement.body).calledTwice
    ).to.be.true
  })

  it('should call parseNode with update each loop', () => {
    setTestResults([true, true, false])

    esprimaParser.ForStatement(forStatement)

    expect(
      esprimaParser.parseNode
        .withArgs(forStatement.update).calledTwice
    ).to.be.true
  })

  it('should break loop given parseLoopBody return state FlowState.BREAK and return result from parseLoopBody', () => {
    setTestResults([true, true, true])

    esprimaParser.parseLoopBody
      .onCall(1).returns({
        result: resultStub,
        state: FlowState.BREAK
      })
    const result = esprimaParser.ForStatement(forStatement)

    expect(esprimaParser.parseLoopBody.calledTwice).to.be.true
    expect(result).to.be.equal(resultStub)
  })

  it('should return last result from parseLoopBody given no FlowState.BREAK signal', () => {
    setTestResults([true, true, true])
    esprimaParser.parseLoopBody
      .onCall(2).returns({
        result: resultStub
      })
    const result = esprimaParser.ForStatement(forStatement)

    expect(result).to.be.equal(resultStub)
  })

  it('should return undefined given test fails from beginning', () => {
    setTestResults([false])

    const result = esprimaParser.ForStatement(forStatement)

    expect(esprimaParser.parseLoopBody.called).to.be.false
    expect(result).to.be.undefined
  })
})