import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchSources } from '../../api/sources';

export default function HomeRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    fetchSources().then((sources) => {
      if (sources.length > 0) {
        navigate(`/source/${sources[0].id}`, { replace: true });
      } else {
        navigate('/requests', { replace: true });
      }
    }).catch(() => {
      navigate('/requests', { replace: true });
    });
  }, []);

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-muted-foreground">Loading...</div>
    </div>
  );
}
