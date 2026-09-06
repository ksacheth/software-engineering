# WVS Document Authority

The project uses one requirements source and a defined derivation chain.

| Document | Role | Authority |
|---|---|---|
| [SRS v1.2](srs/SRS.md) | Functional, non-functional, and design requirements | Sole authoritative requirements source |
| [DFD design document](dfd/Website_Vulnerability_Scanner_DFD.md) and `dfd/mermaid/*.mmd` | Data flows and diagram sources | Derived design artifacts; must conform to the SRS |
| `dfd/*.drawio` and `dfd/mermaid/*.drawio` | Editable diagram views | Derived visual artifacts; must conform to the Markdown DFD and Mermaid sources |
| `dfd/Website_Vulnerability_Scanner_DFD_Report.tex` and `output/pdf/*` | Printable reports | Generated presentation artifacts |
| `srs/SRS-humanised.md` and `srs/SRS-plain.txt` | Accessible reading copies | Derived presentation artifacts |
| `archive/*` | Historical reference | Non-authoritative |
| [CONTEXT.md](../CONTEXT.md) | Repository onboarding summary | Non-authoritative |

When a requirement changes, update `srs/SRS.md` first. Then align the DFD,
presentation copies, and generated PDFs in the same change. Do not treat an
archive file or generated artifact as a requirements source.
