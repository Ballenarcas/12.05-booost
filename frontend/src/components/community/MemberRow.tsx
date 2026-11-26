import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Member } from '../../types/social'
import Avatar from './Avatar'

/** One member in a list, with optional buttons on the right. */
export default function MemberRow({ member, children }: { member: Member; children?: ReactNode }) {
  return (
    <li className="cm-member">
      <Link to={`/community/u/${member.username}`} className="cm-author">
        <Avatar name={member.name || member.username} url={member.avatar_url} />
        <span className="cm-author-text">
          <strong>{member.name || member.username}</strong>
          <span>@{member.username}</span>
        </span>
      </Link>
      {children && <span className="cm-member-actions">{children}</span>}
    </li>
  )
}
