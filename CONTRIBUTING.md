# Contributing to HAZEL

Thank you for wanting to help. HAZEL is a safety-related tool, so the most
useful contributions are the ones that make its results more correct and its
limits clearer. This page explains how to take part.

## The ground rule: sources first

No formula enters the code without being checked against its source. This
applies to every contribution that changes a calculation:

- **Cite the source** in a code comment next to the formula: author, year,
  document, and section or equation number.
- **Do not guess.** If a source is unreadable, ambiguous or missing, leave the
  feature out or record the gap as a limitation in `engineLimitations.js`,
  explaining why. A documented limitation is a good contribution; a silently
  plausible number is not.
- **Do not copy proprietary code or data.** Contribute only work you wrote
  yourself or material whose licence allows redistribution under the project's
  licence. Describe where equations come from; do not paste text from copyrighted
  documents beyond a short, attributed quotation.
- **Say when the source and another tool disagree.** Comparisons with other
  programs are welcome as regression checks, but a published source takes
  precedence over a result from any program.

## Ways to contribute

- **Sources.** Older handbooks, reports and papers that were never digitised,
  or that let us replace one of the simplifications listed on the
  [About page](https://hazel-project.eu/about.html#known-simplifications) with
  the real method. If you can scan or cite them, open an issue or write to
  <damian@kocie.mba>.
- **Verification.** Independent checks of a model against a worked example,
  measured data or another published calculation. Include inputs, outputs and
  the reference, so the result can be reproduced.
- **Bug reports.** See below.
- **Code and documentation.** Fixes, tests, clearer wording, translations of
  the interface or the documentation pages.

## Reporting a problem

Open a GitHub issue and include:

1. What you entered (substance, source type, weather, wind, location type) —
   ideally the exported scenario or a screenshot of the inputs.
2. What HAZEL showed, and what you expected, with the reference for the
   expected value.
3. Browser and device, and whether you use the hosted version or your own copy.

Please send security-relevant findings by e-mail to <damian@kocie.mba>
instead of opening a public issue.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Keep the existing structure: vanilla JavaScript ES modules, no frameworks,
   no build step. Physics lives in `js/engine/` (`engine*.js`) as pure functions
   without access to the DOM or application state; data and browser-storage
   code lives in `js/services/`; user interface code lives in `js/ui/`
   (`step*.js`, `page*.js` and the panels).
3. Work in SI units inside the engines and convert at the edge, in the
   `step*.js` layer.
4. Add or update tests. Every engine has a `*Tests.js` file in `tests/`; run the
   affected ones from the repository root with `node tests/<name>Tests.js`
   and make sure none fails. Prefer tests of
   properties (scaling, limits, conservation) and of worked examples from the
   cited source over tests that only repeat a single number.
5. If a change makes an existing limitation obsolete, or introduces a new one,
   update `engineLimitations.js` and, where it affects what users are told,
   the text in `about.html` and `how-to-use.html`. Those two pages are also
   loaded into the application, so edit them in one place only.
6. If you change a file listed in `CACHE_FILES` in `sw.js`, or add a file the
   application needs offline, add it to that list and bump `CACHE_NAME`.
7. Open a pull request. Describe what changed, why, and which source supports
   it. Keep pull requests focused; one topic per request is easier to review.

Coding style: follow the surrounding code; explain *why* in comments rather
than *what*; name physical quantities with their units where it is not
obvious.

## Licence of contributions

HAZEL is licensed under the [Apache License 2.0](LICENSE). By submitting a
contribution (a pull request, a patch, or a source document intended for
inclusion), you agree that, as provided in section 5 of that licence, it is
submitted under the terms of the Apache License 2.0, without any additional
terms or conditions. You confirm that you have the right to submit it.

To make this explicit, please sign off each commit with the Developer
Certificate of Origin (<https://developercertificate.org/>):

```sh
git commit -s -m "Describe the change"
```

This adds a `Signed-off-by: Your Name <you@example.org>` line and states that
you have the right to contribute the work under the project's licence.

Contributors are not paid and are not employees or agents of the project, and
the project gives no warranty to them or to anyone else; see the licence.

## Credit

With your consent, everyone who helps is credited on the About page as a
co-author or supporter. Tell us in the issue or pull request how you would like
to be named, or that you prefer not to be named.

## Conduct

Be courteous and keep discussions about the work. Disagreements about a model
are settled by sources and tests. Harassment and personal attacks are not
tolerated; maintainers may remove comments or contributions and block users
who persist.
