// The HackerOne adapter: everything ScopeDown knows about HackerOne, behind the platform
// contract in ../index.js.
import * as program from './program.js';
import * as agent from './agent.js';

export default {
  id: 'hackerone',
  label: 'HackerOne',
  origin: agent.ORIGIN,
  weaknessLabel: 'Weakness',
  program: {
    match: program.match,
    inPageArgs: program.inPageArgs,
    fetchInPage: program.fetchInPage,
    normalize: program.normalize,
  },
  agent: {
    account: agent.account,
    program: agent.program,
    listPrograms: agent.listPrograms,
    weaknesses: agent.weaknesses,
    resolveWeakness: agent.resolveWeakness,
    requirements: agent.requirements,
    myReports: agent.myReports,
    myReport: agent.myReport,
    disclosed: agent.disclosed,
    file: agent.fileReport,
    prefill: agent.prefill,
    findFiled: agent.findFiled,
    formUrl: agent.formUrl,
    formFields: agent.formFields,
  },
};
