import pathlib
d = pathlib.Path(__file__).parent
app = (d / "app.html").read_text(encoding="utf-8")
router = (d / "router.js").read_text(encoding="utf-8")
assert "</script" not in router
import datetime
ver = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime("%m%d.%H%M")
(d.parent if d.name == "src" else d).joinpath("index.html").write_text(app.replace("/*ROUTER*/", router).replace("__VER__", ver), encoding="utf-8")
print("version", ver)
print("built index.html", len(app) + len(router))
