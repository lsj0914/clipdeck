"""Trusted draft-resource bootstrap only; never executes application/dependency code."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess


def gh_json(endpoint):
    return json.loads(subprocess.check_output(["gh", "api", endpoint], text=True, timeout=60))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--lock", default="packaging/resources.lock.json")
    args = parser.parse_args()
    repo = os.environ["GITHUB_REPOSITORY"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid repository")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.tag):
        raise ValueError("Invalid fixed resource tag")
    lock = json.loads(pathlib.Path(args.lock).read_text())
    expected = list(lock["assets"].values())
    releases = gh_json(f"repos/{repo}/releases?per_page=100")
    matches = [release for release in releases if release["tag_name"] == args.tag]
    if len(matches) != 1 or not matches[0]["draft"]:
        raise ValueError("Expected exactly one explicit draft bootstrap release")
    release = matches[0]
    assets = release["assets"]
    if sorted(asset["name"] for asset in assets) != sorted(asset["file"] for asset in expected):
        raise ValueError("Draft bootstrap must contain exactly the four locked resource assets")
    out = pathlib.Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    receipt = {"schema": 1, "tag": args.tag, "draft": True, "releaseId": release["id"], "assets": []}
    for wanted in expected:
        asset = next(item for item in assets if item["name"] == wanted["file"])
        if not isinstance(asset["id"], int) or asset["size"] != wanted["bytes"]:
            raise ValueError("Release asset metadata mismatch")
        destination = out / wanted["file"]
        with destination.open("xb") as handle:
            subprocess.run(["gh", "api", f"repos/{repo}/releases/assets/{asset['id']}", "-H", "Accept: application/octet-stream"], stdout=handle, check=True, timeout=600)
        digest = hashlib.sha256()
        with destination.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        if destination.stat().st_size != wanted["bytes"] or digest.hexdigest() != wanted["sha256"]:
            raise ValueError("Downloaded resource bytes/hash mismatch")
        receipt["assets"].append({"id": asset["id"], **wanted})
    (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
