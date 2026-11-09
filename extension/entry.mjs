import { registerReviewCommands } from './review-ui.mjs';
import { registerWorkflows } from './workflows.mjs';

export function activate(context, vscode) {
  const state = registerWorkflows(vscode, context);
  registerReviewCommands(vscode, context, state.recordReview, state.openInlineReview);
  return state;
}
