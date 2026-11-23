// The Bugcrowd adapter: everything ScopeDown knows about Bugcrowd, behind the platform
// contract in ../index.js. Bugcrowd has no direct filing (its form needs a captcha), so
// ScopeDown fills the form for the hunter instead, and no public disclosed-report search.
import * as program from './program.js';
import * as agent from './agent.js';

export default {
  id: 'bugcrowd',
  label: 'Bugcrowd',
  origin: agent.ORIGIN,
  weaknessLabel: 'VRT',
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
    findFiled: agent.findFiled,
    formUrl: agent.formUrl,
    formFields: agent.formFields,
    severityFor: agent.severityFor,
    prefill: agent.prefill,
  },
};
