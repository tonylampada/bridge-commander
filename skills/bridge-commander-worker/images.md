# An image in front of the captain

Three ways. Which one is right depends on where the image goes, not on how it gets there.

**The picture IS the deliverable** — a screenshot, a chart, a diagram he opens on its own. Put
it on the card's artifact list; it opens in the viewer with a click:

```
bc-axi card artifact add <CARD> --uri file://<abs path>/shot.png --label "the new panel" --workspace <ws>
```

**The picture is inside a document** — a markdown artifact or a card body, prose with a figure
in it. Upload the file and paste the line the upload prints:

```
bc-axi attach <abs path>/shot.png --workspace <ws>
#   a1b2c3d4e5f60718
#   ![shot.png](attachment://a1b2c3d4e5f60718)
```

That line renders in a markdown artifact AND in a card body. In a markdown artifact you also
have the shorter option: write the image into the same directory as the `.md` and reference it
by name — `![](shot.png)` resolves against the document's own folder. A card body has no folder,
so there `attachment://` is the only thing that works.

**The picture is beside an HTML artifact** — a page you built. A relative path is all it needs:
`<img src="shot.png">` next to `report.html` loads, same as any page on the web. Nothing to
upload.
