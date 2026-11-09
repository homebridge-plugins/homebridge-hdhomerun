# Publishing to npm (so it shows in the Homebridge plugin search)

Homebridge Config UI X finds plugins on npm: any package whose name starts with
`homebridge-` and has the keyword `homebridge-plugin`. This one has both, so it
appears in the search once it is published.

## Once

1. Make an account at https://www.npmjs.com/signup and turn on two-factor authentication.
2. Make an account at https://github.com/signup.
3. Check the name is free: `npm view homebridge-hdhomerun-monitor`
   A `404 Not Found` means it is free. If it is taken, change `"name"` in package.json
   (it must still start with `homebridge-`) and in the README.
4. Put your name and GitHub username in the package:

   ```sh
   cd ~/Documents/homebridge-hdhomerun-monitor
   sed -i '' 's/YOUR-GITHUB-USERNAME/your-username/g; s/YOUR NAME/Your Name/g' package.json LICENSE
   ```

5. Create an empty public repository on GitHub called `homebridge-hdhomerun-monitor`
   (no README, licence or .gitignore), then:

   ```sh
   git init -b main
   git add .
   git commit -m "HDHomeRun Monitor 1.2.0"
   git remote add origin https://github.com/your-username/homebridge-hdhomerun-monitor.git
   git push -u origin main
   ```

6. Log in to npm from Terminal: `npm login`

## Each release

1. Note the changes in CHANGELOG.md.
2. Raise the version (also commits and tags): `npm version patch` (1.2.0 → 1.2.1),
   `npm version minor` for new features, `npm version major` for breaking changes.
3. Check what will be published: `npm pack --dry-run`
4. Publish: `npm publish`
5. Push the commit and tag: `git push --follow-tags`
6. On GitHub, Releases → Draft a new release → pick the tag → paste the changelog.

The package is on npm straight away, so `npm install -g homebridge-hdhomerun-monitor`
works at once. The Config UI X search uses npm's search index, which can take from
minutes to a day to include a new package.

## Optional: "Verified by Homebridge"

Verified plugins get a badge in the search. Apply by opening an issue on
https://github.com/homebridge/plugins using the verification template; the
checklist there is what reviewers test (a config.schema.json, GitHub issues
enabled, releases with notes, no post-install scripts, data kept in the
Homebridge storage folder, starts cleanly with no devices configured).
