-- Let the anon role CALL the tenant helpers, so a request with a dead token is refused cleanly.
--
-- The helpers read the caller's own profile by auth.uid(). For an anonymous caller that is no
-- row at all: my_client_id() -> null, my_role() -> null, is_my_staff() -> false, and every
-- policy that uses them evaluates to false — a plain denial.
--
-- Without this grant the same request does not get denied, it ERRORS: a student whose login
-- expired on a sleeping phone sent their homework photos with the dead token, the storage
-- service evaluated the upload as anon, and Postgres answered
--   "permission denied for function my_client_id"
-- — which is what the students were shown. Nothing is opened up by this: the functions expose
-- nothing to anon that it could not already not-see; they just stop throwing.

grant execute on function public.my_client_id() to anon;
grant execute on function public.my_role()      to anon;
grant execute on function public.is_my_staff()  to anon;
