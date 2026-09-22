UUID := sound-modes@theophilediot.github.io
SOURCES := lib ui icons LICENSE

.PHONY: test pack install

test:
	glib-compile-schemas --strict --dry-run schemas
	for t in tests/test-*.js; do [ -e "$$t" ] || continue; timeout 60 gjs -m $$t || exit 1; done

pack: test
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist \
		--schema=schemas/org.gnome.shell.extensions.sound-modes.gschema.xml \
		$(foreach f,$(SOURCES),--extra-source=$(f)) .

install: pack
	gnome-extensions install --force dist/$(UUID).shell-extension.zip
