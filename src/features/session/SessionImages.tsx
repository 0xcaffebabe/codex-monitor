import { Image as ImageIcon } from 'lucide-react';
import type { TimelineEvent } from '../../types';
import { SessionImage } from './SessionImage';

export function SessionImages({
  sessionId,
  events,
}: {
  sessionId: string;
  events: TimelineEvent[];
}) {
  return (
    <article className="image-event" id={'event-' + events[0].id}>
      <div className="image-event-heading">
        <ImageIcon size={15} />
        <span>已查看 {events.length} 张图片</span>
      </div>
      <div className="image-thumbnails">
        {events.map((event) => (
          <SessionImage key={event.id} sessionId={sessionId} image={event.image!} />
        ))}
      </div>
    </article>
  );
}
