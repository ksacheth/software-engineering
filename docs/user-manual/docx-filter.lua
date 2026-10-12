-- Pandoc filter for the Word build of the manual (see build-docx.ts).
--
-- Headings marked class="page" start a new page, as they do in the PDF, and
-- each figure's width class (w100, w85, ...) becomes a percentage width so the
-- screenshots keep the sizes they have in the PDF.

local PAGE_BREAK = pandoc.RawBlock("openxml", '<w:p><w:r><w:br w:type="page"/></w:r></w:p>')

function Header(h)
  if h.classes:includes("page") then
    return { PAGE_BREAK, h }
  end
end

function Figure(fig)
  local width
  for _, class in ipairs(fig.classes) do
    width = width or class:match("^w(%d+)$")
  end
  if not width then return nil end
  return pandoc.walk_block(fig, {
    Image = function(img)
      img.attributes.width = width .. "%"
      return img
    end,
  })
end

-- Tables span the text width, each column getting a share in proportion to
-- its longest cell (within limits), so short codes don't get squeezed.
function Table(tbl)
  local longest = {}
  local function measure(rows)
    for _, row in ipairs(rows) do
      for i, cell in ipairs(row.cells) do
        local n = #pandoc.utils.stringify(cell.contents)
        longest[i] = math.max(longest[i] or 0, n)
      end
    end
  end
  measure(tbl.head.rows)
  for _, body in ipairs(tbl.bodies) do measure(body.body) end

  local total = 0
  for i = 1, #tbl.colspecs do
    longest[i] = math.min(math.max(longest[i] or 1, 10), 60)
    total = total + longest[i]
  end
  for i, spec in ipairs(tbl.colspecs) do
    tbl.colspecs[i] = { spec[1], longest[i] / total }
  end
  return tbl
end
