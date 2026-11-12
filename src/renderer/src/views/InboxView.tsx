import { useEffect, useMemo } from 'react'
import { useItems, useStore } from '../store'
import { InboxCanvas } from '../components/InboxCanvas'
import { TagRail } from '../components/TagRail'
import { Icon } from '../components/Icon'
import { itemMatchesQuery, parseQuery } from '../lib/search'

export function InboxView(): React.JSX.Element {
  const items = useItems()
  const lib = useStore((s) => s.lib)
  const search = useStore((s) => s.search)
  const focusTag = useStore((s) => s.focusTag)
  const tagRailOpen = useStore((s) => s.tagRailOpen)
  const setTagRailOpen = useStore((s) => s.setTagRailOpen)
  const tileSize = useStore((s) => s.lib?.settings.tileSize ?? 210)
  const setViewOrder = useStore((s) => s.setViewOrder)

  const parsed = useMemo(
    () => parseQuery(search, (lib?.tags ?? []).map((tag) => tag.name)),
    [search, lib?.tags]
  )

  const inbox = useMemo(() => {
    return items.filter((i) => {
      if (!i.inbox) return false
      return itemMatchesQuery(i, parsed)
    })
  }, [items, parsed])

  // Publish the filtered order so the full-screen viewer can cycle through it.
  useEffect(() => {
    setViewOrder(inbox.map((item) => item.id))
  }, [inbox, setViewOrder])

  return (
    <div className="inbox">
      <InboxCanvas items={inbox} focusTag={focusTag} base={tileSize} />
      {tagRailOpen ? (
        <TagRail />
      ) : (
        <div className="tagrail-collapsed">
          <button onClick={() => setTagRailOpen(true)}>
            <Icon name="tag" size={13} />
            Tags
          </button>
        </div>
      )}
    </div>
  )
}
