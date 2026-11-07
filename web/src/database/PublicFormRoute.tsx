import { useParams } from 'react-router-dom';
import './database.css';
import { PublicFormPage } from './FormView';

/** /f/:slug — public form (no login). */
export default function PublicFormRoute() {
  const { slug } = useParams();
  return <PublicFormPage slug={slug ?? ''} />;
}
