"""TEST HARNESS ONLY (never shipped): make ComfyUI validate prompts but skip execution.

POST /prompt still runs the real validation (node types, inputs, combo values, links);
the executor then returns success immediately without loading any model.
"""
import logging

import execution


def _noop_execute(self, prompt, prompt_id, extra_data={}, execute_outputs=[]):  # noqa: B006
    self.success = True
    self.status_messages = []
    self.history_result = {"outputs": {}, "meta": {}}


execution.PromptExecutor.execute = _noop_execute
logging.warning("kitty harness: execution disabled, validation only")
NODE_CLASS_MAPPINGS = {}
