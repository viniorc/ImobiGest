import { runStage02Tests } from './stage02.test.js';
import { runStage03Tests } from './stage03.test.js';
import { runStage04Tests } from './stage04.test.js';
import { runStage05Tests } from './stage05.test.js';
import { runStage06Tests } from './stage06.test.js';
import { runStage07Tests } from './stage07.test.js';
import { runStage08Tests } from './stage08.test.js';
import { runStage09Tests } from './stage09.test.js';
import { runStage10Tests } from './stage10.test.js';
import { runStage11Tests } from './stage11.test.js';

const button = document.querySelector('#run-tests');
const summary = document.querySelector('#test-summary');
const list = document.querySelector('#test-results');
document.body.dataset.testState = 'idle';
button.addEventListener('click', async () => {
  button.disabled = true;
  list.replaceChildren();
  summary.textContent = 'Executando verificações isoladas…';
  document.body.dataset.testState = 'running';
  try {
    const suites = { '02': runStage02Tests, '03': runStage03Tests, '04': runStage04Tests, '05': runStage05Tests, '06': runStage06Tests, '07': runStage07Tests, '08': runStage08Tests, '09': runStage09Tests, '10': runStage10Tests, '11': runStage11Tests };
    const selected = document.body.dataset.suite === 'all' ? Object.entries(suites) : [[document.body.dataset.suite || '02', suites[document.body.dataset.suite] || runStage02Tests]];
    const runTests = async (report) => {
      const all = [];
      for (const [stage, run] of selected) all.push(...await run(result => report({ ...result, name: `[${stage}] ${result.name}` })));
      return all;
    };
    const results = await runTests((result) => {
      const item = document.createElement('li');
      item.className = result.passed ? 'test-pass' : 'test-fail';
      item.textContent = `${result.passed ? 'PASSOU' : 'FALHOU'} — ${result.name}${result.error ? `: ${result.error}` : ''}`;
      list.append(item);
    });
    const failed = results.filter((result) => !result.passed).length;
    summary.textContent = `${results.length - failed} passaram; ${failed} falharam. Total: ${results.length}.`;
    document.body.dataset.testState = failed ? 'failed' : 'passed';
  } catch (error) {
    summary.textContent = `Não foi possível concluir a execução: ${error.message}`;
    document.body.dataset.testState = 'failed';
  } finally { button.disabled = false; }
});
