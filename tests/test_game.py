import subprocess

from pokerogue_player.game import patch_bundle_text

BUNDLE = (
    "var a=1;function initGlobalScene(e){globalScene=e}"
    "function getMoveTargets(e,t,n){return{targets:[t],multiple:!1}}"
    "export{getMoveTargets as g};"
)


def test_patch_bundle_exposes_scene_and_move_targets():
    out, applied = patch_bundle_text(BUNDLE)
    assert applied == ["initGlobalScene", "getMoveTargets"]
    assert "window.__prScene=e;" in out
    assert "}window.__prGetMoveTargets=getMoveTargets;function getMoveTargets(" in out


def test_patch_bundle_leaves_other_files_alone():
    body = "console.log('getMoveTargets is mentioned but not declared')"
    assert patch_bundle_text(body) == (body, [])


def test_patched_bundle_still_runs_and_hoists(tmp_path):
    out, _ = patch_bundle_text("var window={};" + BUNDLE.replace("export{getMoveTargets as g};", ""))
    script = out + "console.log(JSON.stringify(window.__prGetMoveTargets(0,5)))"
    res = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=30)
    assert res.stdout.strip() == '{"targets":[5],"multiple":false}', res.stderr
