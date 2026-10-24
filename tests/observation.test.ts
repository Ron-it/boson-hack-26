import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { actionCandidates } from '../src/mobile/actions.ts';
import { parseObservation } from '../src/mobile/portal.ts';

function view(overrides: Record<string, unknown> = {}) {
  return {
    resourceId: '', className: 'android.widget.FrameLayout', packageName: 'com.android.settings',
    text: '', contentDescription: '', stateDescription: '',
    boundsInScreen: { left: 0, top: 0, right: 1080, bottom: 2424 },
    isClickable: false, isCheckable: false, isChecked: false,
    isEnabled: true, isVisibleToUser: true, isScrollable: false,
    isEditable: false, isPassword: false, actionList: [], children: [],
    ...overrides,
  };
}

// Reproduces the Pixel 10 hierarchy that caused the model to toggle Night Light twice:
// a clickable row owns separate label and unlabeled, non-clickable switch children.
function nightLightScreen(checked: boolean) {
  return parseObservation({
    a11y_tree: view({
      children: [view({
        className: 'android.widget.LinearLayout', isClickable: true,
        boundsInScreen: { left: 0, top: 1993, right: 1080, bottom: 2182 },
        children: [
          view({
            className: 'android.widget.TextView', text: 'Night Light',
            boundsInScreen: { left: 221, top: 2059, right: 441, bottom: 2115 },
          }),
          view({
            className: 'android.widget.Switch', isCheckable: true,
            isChecked: checked, stateDescription: checked ? 'ON' : 'OFF',
            boundsInScreen: { left: 859, top: 2024, right: 996, bottom: 2150 },
          }),
        ],
      })],
    }),
    phone_state: { packageName: 'com.android.settings', activityName: 'SubSettings' },
  });
}

test('the model action menu carries the native state of a preference row with an unlabeled switch', () => {
  const off = nightLightScreen(false);
  const on = nightLightScreen(true);
  for (const [observation, expected] of [[off, 'OFF'], [on, 'ON']] as const) {
    const candidate = actionCandidates(observation)
      .find(candidate => candidate.description === `Tap "Night Light". Currently ${expected}.`);
    assert.ok(candidate, `Missing ${expected} state on the action the model can actually execute`);
    assert.equal(candidate.action.type, 'tap');
    if (candidate.action.type === 'tap') {
      assert.equal(candidate.action.x, 540);
      assert.equal(candidate.action.y, 2088);
    }
    assert.equal(observation.app.currentApp, 'com.android.settings');
  }
  assert.notEqual(JSON.stringify(off), JSON.stringify(on));
});
